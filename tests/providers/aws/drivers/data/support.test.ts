import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  Attributes,
  canonicalJson,
  classifyAwsError,
  configInt,
  escapeTemplate,
  expectedFor,
  findByTags,
  matchesExpectedCheck,
  safeTags,
  sameValue,
  tagMap,
  tagsMatchNode,
  verificationOf,
} from "@/lib/providers/aws/drivers/data/support";
import type { Observation } from "@/lib/resources/types";
import { awsError, driverCtx, mkNode, tagRecord } from "./_helpers";

const tagging = mockClient(ResourceGroupsTaggingAPIClient);
beforeEach(() => tagging.reset());
afterAll(() => tagging.restore());

describe("template escaping", () => {
  it("turns interpolation and directive openers into literals", () => {
    expect(escapeTemplate("${file('/etc/passwd')}")).toBe("$${file('/etc/passwd')}");
    expect(escapeTemplate("%{ if true }x%{ endif }")).toBe("%%{ if true }x%%{ endif }");
    expect(escapeTemplate("plain text")).toBe("plain text");
    expect(escapeTemplate("a ${b} ${c}")).toBe("a $${b} $${c}");
  });

  it("escapes both keys and values of tags", () => {
    expect(safeTags({ "k${x}": "v${y}" })).toEqual({ "k$${x}": "v$${y}" });
  });
});

describe("bounded config reads", () => {
  const node = (config: Record<string, unknown>) => mkNode("queue/q", "queue", { config });

  it("reads integers, accepts numeric strings, and refuses everything else instead of clamping", () => {
    expect(configInt(node({ n: 5 }), "n", 1, 10)).toBe(5);
    expect(configInt(node({ n: "7" }), "n", 1, 10)).toBe(7);
    expect(configInt(node({}), "n", 1, 10)).toBeUndefined();
    for (const bad of [0, 11, 1.5, "1.5", "abc", "-3", "", true, "99999999999"]) {
      expect(() => configInt(node({ n: bad }), "n", 1, 10), String(bad)).toThrow(/between 1 and 10/);
    }
  });

  it("ignores non-scalar config members", () => {
    expect(configInt(node({ n: { x: 1 } }), "n", 1, 10)).toBeUndefined();
  });
});

describe("comparison and verification", () => {
  it("compares scalars by text and structures canonically", () => {
    expect(sameValue(3, "3")).toBe(true);
    expect(sameValue(true, "true")).toBe(true);
    expect(sameValue(false, "true")).toBe(false);
    expect(sameValue({ b: 1, a: [1, 2] }, { a: [1, 2], b: 1 })).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(canonicalJson({ b: undefined, a: 1 })).toBe('{"a":1}');
  });

  const obs = (over: Partial<Observation> = {}): Observation => ({
    address: "queue/q",
    presence: "present",
    attributes: { a: { state: "known", value: 1, observedAt: "t" }, b: { state: "unknown", reason: "access_denied" } },
    observedAt: "t",
    source: "x",
    simulated: false,
    ...over,
  });
  const node = mkNode("queue/q", "queue", {});
  const ctx = driverCtx();

  it("matchesExpectedCheck: names only, unknown when nothing was comparable, nothing when nothing is expected", () => {
    expect(matchesExpectedCheck({}, obs())).toBeUndefined();
    expect(matchesExpectedCheck({ a: 1 }, obs())).toMatchObject({ passed: true });
    expect(matchesExpectedCheck({ a: 2 }, obs())).toMatchObject({ passed: false, detail: "differs on a" });
    expect(matchesExpectedCheck({ b: 1, zzz: 1 }, obs())).toMatchObject({ passed: "unknown" });
  });

  it("verificationOf: failed beats unknown beats passed, and an absent or unreadable object short-circuits", () => {
    const pass = { id: "p", description: "p", passed: true as const };
    const fail = { id: "f", description: "f", passed: false as const };
    const unk = { id: "u", description: "u", passed: "unknown" as const };
    expect(verificationOf(ctx, node, obs(), [pass]).status).toBe("passed");
    expect(verificationOf(ctx, node, obs(), [pass, unk]).status).toBe("unknown");
    expect(verificationOf(ctx, node, obs(), [pass, unk, fail]).status).toBe("failed");
    expect(verificationOf(ctx, node, obs(), [undefined, pass]).checks.map((c) => c.id)).toEqual(["exists", "p"]);
    expect(verificationOf(ctx, node, obs({ presence: "missing" }), [pass])).toMatchObject({ status: "failed", checks: [{ id: "exists", passed: false }] });
    expect(verificationOf(ctx, node, obs({ presence: "inaccessible" }), [pass]).status).toBe("unknown");
    expect(verificationOf(ctx, node, obs({ presence: "unknown" }), [pass]).status).toBe("unknown");
  });
});

describe("Attributes", () => {
  it("distinguishes read-and-absent (null), not returned (undefined) and never read", () => {
    const a = new Attributes(driverCtx());
    a.set("present", 1);
    a.set("absent", null);
    a.set("missingField", undefined);
    const out = a.finish(["present", "absent", "missingField", "neverRead"]);
    expect(out.present).toMatchObject({ state: "known", value: 1 });
    expect(out.absent).toMatchObject({ state: "known", value: null });
    expect(out.missingField).toMatchObject({ state: "unknown", reason: "not_applicable" });
    expect(out.neverRead).toMatchObject({ state: "unknown", reason: "not_inspected" });
  });
});

describe("expectedFor", () => {
  it("expects nothing for referenced nodes and for specs the driver refuses, and rethrows real bugs", () => {
    const managed = mkNode("queue/q", "queue", {});
    expect(expectedFor({ ...managed, ownership: "referenced" }, () => ({ a: 1 }))).toEqual({});
    expect(expectedFor(managed, () => ({ a: 1 }))).toEqual({ a: 1 });
    expect(expectedFor(managed, () => configInt(mkNode("queue/q", "queue", { config: { n: "x" } }), "n", 1, 2) as never)).toEqual({});
    expect(() => expectedFor(managed, () => { throw new TypeError("a bug"); })).toThrow(TypeError);
  });
});

describe("error classification and tags", () => {
  it("adds SQS's legacy NonExistentQueue to the shared not-found set and leaves the rest alone", () => {
    expect(classifyAwsError(awsError("AWS.SimpleQueueService.NonExistentQueue", "x", 400)).kind).toBe("missing");
    expect(classifyAwsError(awsError("QueueDoesNotExist", "x", 400)).kind).toBe("missing");
    expect(classifyAwsError(awsError("AccessDenied", "x", 403)).kind).toBe("inaccessible");
    expect(classifyAwsError(awsError("Throttling", "x", 400)).kind).toBe("throttled");
    expect(classifyAwsError(awsError("ValidationError", "x", 400)).kind).toBe("error");
  });

  it("tagMap sorts and accepts both provider shapes; tagsMatchNode needs workspace, environment and resource", () => {
    expect(tagMap([{ Key: "b", Value: "2" }, { Key: "a" }, {}])).toEqual({ a: "", b: "2" });
    expect(Object.keys(tagMap({ z: "1", a: "2" }))).toEqual(["a", "z"]);
    const node = mkNode("queue/q", "queue", {});
    const ctx = driverCtx();
    expect(tagsMatchNode(tagRecord("queue/q"), ctx, node)).toBe(true);
    expect(tagsMatchNode(tagRecord("queue/other"), ctx, node)).toBe(false);
    expect(tagsMatchNode(tagRecord("queue/q", { "zenith:environment": "env_other" }), ctx, node)).toBe(false);
    expect(tagsMatchNode(tagRecord("queue/q", { "zenith:workspace": "ws_other" }), ctx, node)).toBe(false);
  });
});

describe("findByTags", () => {
  const node = mkNode("queue/q", "queue", {});

  it("always filters by workspace, environment AND resource (tenant scoped) and follows pagination within a bound", async () => {
    tagging
      .on(GetResourcesCommand)
      .resolvesOnce({ ResourceTagMappingList: [{ ResourceARN: "arn:a", Tags: [{ Key: "k", Value: "v" }] }], PaginationToken: "p2" })
      .resolvesOnce({ ResourceTagMappingList: [{ ResourceARN: "arn:b" }] });
    const r = await findByTags(driverCtx(), node, "sqs");
    expect(r.matches.map((m) => m.arn)).toEqual(["arn:a", "arn:b"]);
    expect(r.matches[0].tags).toEqual({ k: "v" });
    expect(r.truncated).toBe(false);
    const [first, second] = tagging.commandCalls(GetResourcesCommand).map((c) => c.args[0].input);
    expect(first.TagFilters).toHaveLength(3);
    expect(second.PaginationToken).toBe("p2");
  });

  it("stops at its page bound and says it is incomplete", async () => {
    tagging.on(GetResourcesCommand).callsFake((input: { PaginationToken?: string }) => ({ ResourceTagMappingList: [], PaginationToken: `t${(input.PaginationToken ?? "t0").slice(1)}x` }));
    const r = await findByTags(driverCtx(), node, "sqs");
    expect(r.truncated).toBe(true);
    expect(tagging.commandCalls(GetResourcesCommand).length).toBeLessThanOrEqual(5);
  });

  it("uses the region override for global services", async () => {
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
    const seen: string[] = [];
    const session = driverCtx().session;
    const ctx = driverCtx({ session: { ...session, client: ((ctor: new (c: Record<string, unknown>) => unknown, o?: { region?: string }) => { seen.push(o?.region ?? "none"); return session.client(ctor as never, o); }) as typeof session.client } });
    await findByTags(ctx, node, "iam:role", { region: "us-east-1" });
    expect(seen).toEqual(["us-east-1"]);
  });
});
