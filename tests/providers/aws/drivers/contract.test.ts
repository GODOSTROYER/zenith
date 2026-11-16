/** Provider-wide contract checks; fake sessions return only mocked SDK data. */
import { describe, expect, it } from "vitest";
import { awsDrivers, NOT_YET_IMPLEMENTED, registerAwsDrivers } from "@/lib/providers/aws/drivers";
import { findDriver, listDrivers, type DriverContext } from "@/lib/drivers/types";
import type { AwsSession } from "@/lib/credentials/types";
import { NATIVE_TYPE_TABLE } from "@/lib/resources/native-types";
import { classifyAwsError, resourceTags, tfLiteral } from "@/lib/providers/aws/drivers/shared";
import { buildFullFixture } from "./compute/fixtures";
import { compileContext, expanded, TAGS } from "./_integration";
import { mkNode } from "./data/_helpers";

const graph = expanded("production");
const extras = [
  ...buildFullFixture().nodes,
  mkNode("pubsub/events", "pubsub", {}),
  mkNode("volume/data", "volume", { sizeGb: 64, availabilityZone: "ap-south-1a" }),
  mkNode("kubernetes_cluster/apps", "kubernetes_cluster", { version: "1.35" }, { dependsOn: ["subnet/private-a", "subnet/private-b"] }),
];
const nodes = [...new Map([...extras, ...graph.nodes].map((n) => [n.address, n])).values()];
const ctx = compileContext({ ...graph, nodes });

describe("the consolidated AWS registry", () => {
  it("contains exactly one driver per key, and every vocabulary row is implemented or an explicit gap", () => {
    const keys = awsDrivers.map((d) => `${d.provider}|${d.nativeType}`);
    expect(new Set(keys).size).toBe(keys.length);
    const vocabulary = new Set(Object.values(NATIVE_TYPE_TABLE.aws));
    expect(new Set([...awsDrivers.map((d) => d.nativeType), ...NOT_YET_IMPLEMENTED])).toEqual(vocabulary);
    for (const type of NOT_YET_IMPLEMENTED) expect(awsDrivers.some((d) => d.nativeType === type)).toBe(false);
  });

  it("registers all groups idempotently", () => {
    registerAwsDrivers();
    const first = listDrivers("aws");
    registerAwsDrivers();
    expect(listDrivers("aws")).toEqual(first);
    for (const driver of awsDrivers) expect(findDriver("aws", driver.nativeType)).toBe(driver);
  });

  it.each(awsDrivers)("$id matches its contract and compiles deterministically without changing the graph", (driver) => {
    expect(driver.provider).toBe("aws");
    expect(driver.id).toBe(`aws.${driver.nativeType.slice(4)}@1`);
    expect(Object.values(NATIVE_TYPE_TABLE.aws)).toContain(driver.nativeType);
    const capabilities = ["compile", "observe", "runtime", "verify", "discover"] as const;
    for (const capability of capabilities) {
      expect(driver.capabilities[capability]).toBe(typeof driver[capability] === "function");
      if (driver.capabilities[capability]) expect(driver.capabilities.evidence[capability]).toBe("contract");
    }
    const refusalOperations = driver.capabilities.refuses ?? [];
    expect(refusalOperations.filter((op) => driver.capabilities.operations.includes(op))).toEqual([]);
    expect(Object.keys(driver.operations ?? {}).sort()).toEqual([...driver.capabilities.operations, ...refusalOperations].sort());
    for (const operation of Object.keys(driver.operations ?? {})) expect(driver.capabilities.evidence[operation]).toBe("contract");
    for (const operation of driver.capabilities.operations) expect(driver.capabilities.evidence[operation]).toBe("contract");
    for (const evidence of Object.values(driver.capabilities.evidence)) expect(evidence).toBe("contract");
    expect(Object.keys(driver.capabilities.evidence).sort()).toEqual([
      ...capabilities.filter((capability) => driver.capabilities[capability]),
      ...driver.capabilities.operations, ...refusalOperations,
    ].sort());
    const node = graph.nodes.find((n) => n.nativeType === driver.nativeType) ?? nodes.find((n) => n.nativeType === driver.nativeType)!;
    expect(node, driver.id).toBeDefined();
    const before = JSON.stringify(nodes);
    const first = JSON.stringify(driver.compile!(node, ctx));
    expect(JSON.stringify(driver.compile!(node, ctx))).toBe(first);
    expect(JSON.stringify(nodes)).toBe(before);
    const hostileTags = { ...ctx, tags: { ...ctx.tags, "team${key}": "value${reference}%{directive}" } };
    const rendered = JSON.stringify(driver.compile!(node, hostileTags));
    if (node.ownership === "managed" && driver.kind !== "dns_record") {
      expect(rendered, driver.id).toContain('"team$${key}":"value$${reference}%%{directive}"');
      expect(rendered, driver.id).not.toContain("$$${");
      expect(rendered, driver.id).not.toContain("%%%{");
    }
  });

  it.each(awsDrivers.filter((driver) => driver.capabilities.observe))("$id never reports desired attributes as known after an empty or denied SDK read", async (driver) => {
    const node = graph.nodes.find((n) => n.nativeType === driver.nativeType) ?? nodes.find((n) => n.nativeType === driver.nativeType)!;
    for (const denied of [false, true]) {
      let sends = 0;
      const session: AwsSession = {
        provider: "aws", accountId: "123456789012", region: node.region, transport: "direct", expiresAt: "2099-01-01T00:00:00Z",
        client: <C>() => ({ send: async () => {
          sends++;
          if (denied) throw Object.assign(new Error("denied"), { name: "AccessDenied" });
          return {};
        } }) as unknown as C,
        childProcessEnv: () => ({}),
      };
      const readCtx: DriverContext<AwsSession> = { provider: "aws", workspaceId: TAGS["zenith:workspace"], environmentId: graph.environmentId,
        region: node.region, tags: TAGS, signal: new AbortController().signal, log: () => {}, now: () => new Date("2026-10-01T00:00:00Z"), session };
      const observation = await driver.observe!(readCtx, node);
      expect(sends, `${driver.id} must exercise an SDK read`).toBeGreaterThan(0);
      expect(observation.address).toBe(node.address);
      expect(observation.simulated).toBe(false);
      expect(Object.values(observation.attributes).every((a) => a.state === "unknown"), driver.id).toBe(true);
    }
  });
});

describe("canonical helpers", () => {
  it.each(["AWS.SimpleQueueService.NonExistentQueue", "QueueDoesNotExist"])("classifies %s without a service-specific wrapper", (code) => {
    expect(classifyAwsError({ name: code }).kind).toBe("missing");
    expect(classifyAwsError({ code }).kind).toBe("missing");
  });

  it("escapes graph-derived tag keys and values exactly once", () => {
    expect(resourceTags({ "tag${key}": "value${ref}%{directive}" }, "queue/${name}")).toEqual({ "tag$${key}": tfLiteral("value${ref}%{directive}"), "zenith:resource": "queue/$${name}" });
  });
});
