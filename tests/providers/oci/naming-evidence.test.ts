/**
 * Naming / tagging / reference conventions, and the honesty of what the drivers
 * claim: evidence is `contract` and nothing more, capability flags match the
 * functions that exist, registration is idempotent and uses the native-type
 * table's exact strings.
 */
import { describe, expect, it } from "vitest";
import { findDriver, listDrivers, type ResourceDriver } from "@/lib/drivers/types";
import { NATIVE_TYPE_TABLE } from "@/lib/resources";
import { ociDrivers, registerOciDrivers } from "@/lib/providers/oci/drivers";
import { OciCompileError } from "@/lib/providers/oci/errors";
import { ociCapabilities } from "@/lib/providers/oci/evidence";
import {
  auxName,
  auxRef,
  cloudName,
  fnv6,
  MAX_FREEFORM_TAGS,
  networkOf,
  nodeCloudName,
  ociPrimaryAddress,
  ociTagKey,
  OCI_PRIMARY_TYPE,
  tfLabel,
  zenithTagKey,
  zenithTags,
} from "@/lib/providers/oci/naming";
import type { ResourceNode } from "@/lib/resources";
import { compileContext, expandOci, nodeOf } from "./_support";

const graph = expandOci();

describe("names", () => {
  it("fnv6 is stable and 6 hex digits", () => {
    expect(fnv6("abc")).toBe(fnv6("abc"));
    expect(fnv6("abc")).toMatch(/^[0-9a-f]{6}$/);
    expect(fnv6("abc")).not.toBe(fnv6("abd"));
  });

  it("cloud names are prefix-name, lowercase, and truncated with a deterministic hash only when too long", () => {
    expect(cloudName("zn-acme", "web", 100)).toBe("zn-acme-web");
    expect(cloudName("ZN", "Web", 100)).toBe("zn-web");
    const long = cloudName("zn-acme", "x".repeat(200), 32);
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(/-[0-9a-f]{6}$/);
    expect(cloudName("zn-acme", "x".repeat(200), 32)).toBe(long);
    expect(cloudName("zn-acme", "y".repeat(200), 32)).not.toBe(long);
    // two long names sharing a prefix still differ
    const a = cloudName("p", `${"z".repeat(60)}-a`, 32);
    const b = cloudName("p", `${"z".repeat(60)}-b`, 32);
    expect(a).not.toBe(b);
    expect(nodeCloudName(compileContext(graph), nodeOf(graph, "container_service/web"), 100)).toBe("zn-acme-web");
  });

  it("tf labels are injective for the names expansion allows", () => {
    const labels = graph.nodes.map((n) => tfLabel(n.address));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("tags", () => {
  it("OCI free-form keys never contain ':' or '.', and map back to the platform vocabulary", () => {
    expect(ociTagKey("zenith:environment")).toBe("zenith_environment");
    expect(ociTagKey("a.b c:d")).toBe("a_b_c_d");
    expect(zenithTagKey("zenith_environment")).toBe("zenith:environment");
    expect(zenithTagKey("other_key")).toBe("other_key");
  });

  it("zenithTags forces the node's own address and environment even if ctx.tags disagrees", () => {
    const node = nodeOf(graph, "queue/jobs");
    const ctx = compileContext(graph, { tags: { "zenith:resource": "queue/not-me", "zenith:environment": "not-this-env", "zenith:managed": "false", team: "core" } });
    expect(zenithTags(ctx, node)).toEqual({ team: "core", zenith_environment: "env-oci", zenith_managed: "true", zenith_resource: "queue/jobs" });
  });

  it("truncates values to 256 characters and refuses more than ten tags", () => {
    const node = nodeOf(graph, "queue/jobs");
    expect(zenithTags(compileContext(graph, { tags: { long: "v".repeat(500) } }), node).long).toHaveLength(256);
    const many = Object.fromEntries(Array.from({ length: MAX_FREEFORM_TAGS }, (_, i) => [`k${i}`, "v"]));
    expect(() => zenithTags(compileContext(graph, { tags: many }), node)).toThrow(OciCompileError);
  });
});

describe("references", () => {
  it("aux locals are <label>_<what> and read back as ${local.…}", () => {
    expect(auxName("network/main", "public_route_table_id")).toBe("network_main_public_route_table_id");
    expect(auxRef("load_balancer/public", "nsg_id")).toBe("${local.load_balancer_public_nsg_id}");
  });

  it("every OCI native type that compiles has a primary resource type; ociPrimaryAddress follows the label rule", () => {
    for (const d of ociDrivers.filter((x) => x.capabilities.compile)) expect(OCI_PRIMARY_TYPE[d.nativeType], d.nativeType).toBeDefined();
    expect(ociPrimaryAddress({ address: "network/main", nativeType: "oci:vcn" })).toBe("oci_core_vcn.network_main");
    expect(ociPrimaryAddress({ address: "tls_certificate/a.b.c", nativeType: "oci:certificate" })).toBe("data.oci_certificates_management_certificates.tls_certificate_a_b_c");
    expect(ociPrimaryAddress({ address: "x/y", nativeType: "oci:oke_cluster" })).toBe("oci_containerengine_cluster.x_y");
    expect(ociPrimaryAddress({ address: "x/y", nativeType: "oci:mysql_db_system" })).toBeUndefined();
  });

  it("networkOf picks the first subnet of the tier, sorted, and its network", () => {
    const web = nodeOf(graph, "container_service/web");
    expect(networkOf(compileContext(graph), web, "private")).toEqual({ network: "network/main", subnets: ["subnet/private-a"] });
    const lb = nodeOf(graph, "load_balancer/public");
    expect(networkOf(compileContext(graph), lb, "public").subnets).toEqual(["subnet/public-a"]);
    expect(() => networkOf(compileContext(graph), lb, "private")).toThrow(/no private subnet/);
    const orphan = { ...web, dependsOn: [] } as ResourceNode;
    expect(() => networkOf(compileContext(graph), orphan, "private")).toThrow(OciCompileError);
  });
});

describe("what the drivers claim", () => {
  it("evidence is `contract` for every claimed operation, and nothing is claimed that does not exist", () => {
    for (const d of ociDrivers) {
      const c = d.capabilities;
      for (const [k, level] of Object.entries(c.evidence)) {
        expect(level, `${d.id} ${k}`).toBe("contract");
        expect(["compile", "observe", "runtime", "verify", "discover", ...c.operations]).toContain(k);
      }
      expect(Object.keys(c.evidence).sort(), d.id).toEqual([...["compile", "observe", "runtime", "verify", "discover"].filter((k) => c[k as "compile"]), ...c.operations].sort());
      expect(!!d.compile, `${d.id} compile`).toBe(c.compile);
      expect(!!d.observe, `${d.id} observe`).toBe(c.observe);
      expect(!!d.runtime, `${d.id} runtime`).toBe(c.runtime);
      expect(!!d.verify, `${d.id} verify`).toBe(c.verify || false);
      expect(!!d.discover, `${d.id} discover`).toBe(c.discover);
      if (c.observe) expect(d.expectedAttributes, `${d.id} expectedAttributes`).toBeDefined();
    }
  });

  it("no driver claims `real` or `emulated` anywhere", () => {
    expect(JSON.stringify(ociDrivers.map((d) => d.capabilities.evidence))).not.toMatch(/real|emulated|simulated/);
    expect(ociCapabilities({ compile: true, operations: ["b", "a"] })).toEqual({ compile: true, observe: false, runtime: false, verify: false, discover: false, operations: ["a", "b"], evidence: { compile: "contract", a: "contract", b: "contract" } });
  });

  it("registers idempotently under (oci, native type) with the table's exact strings", () => {
    registerOciDrivers();
    registerOciDrivers();
    const registered = listDrivers("oci");
    expect(registered.map((d) => d.nativeType).sort()).toEqual(Object.values(NATIVE_TYPE_TABLE.oci).sort());
    for (const nativeType of Object.values(NATIVE_TYPE_TABLE.oci)) expect(findDriver("oci", nativeType)?.id).toBe(`oci.${nativeType.slice(4)}@1`);
    expect(findDriver("oci", "oci:nope")).toBeUndefined();
  });

  it("ids follow <provider>.<suffix>@1", () => {
    for (const d of ociDrivers) expect(d.id).toMatch(/^oci\.[a-z_]+@1$/);
  });

  it("can register again after a registry rebuild", () => {
    registerOciDrivers();
    const global = globalThis as typeof globalThis & { __zenithDrivers?: Map<string, ResourceDriver> };
    global.__zenithDrivers!.delete("oci|oci:compute_instance");
    expect(findDriver("oci", "oci:compute_instance")).toBeUndefined();
    registerOciDrivers();
    expect(findDriver("oci", "oci:compute_instance")).toBe(ociDrivers.find((d) => d.nativeType === "oci:compute_instance"));
  });
});
