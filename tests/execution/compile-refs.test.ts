/**
 * Reference resolution through the execution compiler, using synthetic pure
 * drivers. These prove the compiler's contract, not provider/cloud behavior.
 */
import { describe, expect, it } from "vitest";
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import { compileGraph } from "@/lib/execution/compile";
import { StepFailedError } from "@/lib/execution/errors";
import { refLocalName } from "@/lib/providers/aws/drivers/shared/refs";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";

const target = "network/main";
const source = "service/web";

function node(address: string, over: Partial<ResourceNode> = {}): ResourceNode {
  return { address, provider: "aws", nativeType: address, kind: "provider_native",
    ownership: "managed", region: "us-east-1", spec: {}, specDigest: "0".repeat(64),
    origin: [], dependsOn: [], labels: {}, ...over };
}

function driver(address: string, compile: NonNullable<ResourceDriver["compile"]>): ResourceDriver {
  return { id: `test.${address}`, provider: "aws", nativeType: address, kind: "provider_native",
    capabilities: { compile: true, observe: false, runtime: false, verify: false, discover: false, operations: [], evidence: { compile: "simulated" } }, compile };
}

function resolve(attribute: string, fragment: TofuFragment, options: { target?: Partial<ResourceNode>; source?: string; missingTarget?: boolean } = {}) {
  const sourceAddress = options.source ?? source;
  const calls: string[] = [];
  const graph: ResourceGraph = { version: 1, environmentId: "env-ref", manifestDigest: "m", graphDigest: "g", notes: [], edges: [],
    // The consumer comes first and does not list the target in dependsOn.
    nodes: [node(sourceAddress), ...(options.missingTarget ? [] : [node(target, options.target)])] };
  const drivers = new Map([
    [sourceAddress, driver(sourceAddress, (_, ctx) => {
      calls.push(sourceAddress);
      return { locals: { resolved: ctx.ref(target, attribute) }, addresses: [] };
    })],
    [target, driver(target, () => { calls.push(target); return fragment; })],
  ]);
  const compiled = compileGraph({ graph, environmentId: graph.environmentId, region: "us-east-1", tags: {}, drivers: (_, type) => drivers.get(type) });
  return { value: compiled.fragments.get(sourceAddress)!.locals!.resolved, calls };
}

const primary: TofuFragment = { addresses: ["aws_vpc.network_main"] };

describe("execution reference resolution", () => {
  it("compiles the target on demand and prefers its published local over a primary attribute", () => {
    const result = resolve("arn", { ...primary, locals: { [refLocalName(target, "arn")]: "${aws_acm_certificate_validation.network_validated.certificate_arn}" } });
    expect(result.value).toBe("${local.ref_network_main__arn}");
    expect(result.calls).toEqual([source, target]);
  });

  it.each(["security_group_id", "target_group_arn:container_service/web", "target_group_arn:container_service/web:3000", "private_route_table_id:a", "target_group_arn:service/my-web.example.com:443"])("resolves the published semantic key %s", (attribute) => {
    const name = refLocalName(target, attribute);
    expect(resolve(attribute, { ...primary, locals: { [name]: "${aws_vpc.network_main.id}" } }).value).toBe(`\${local.${name}}`);
  });

  it("resolves an own local without needing a primary address or a truthy value", () => {
    expect(resolve("id", { addresses: [], locals: { [refLocalName(target, "id")]: null } }).value).toBe("${local.ref_network_main__id}");
  });

  it("ignores inherited local declarations", () => {
    const locals = Object.create({ [refLocalName(target, "id")]: "not a declaration" }) as Record<string, unknown>;
    expect(resolve("id", { ...primary, locals }).value).toBe("${aws_vpc.network_main.id}");
  });

  it.each(["id", "arn", "metadata[0].name", "nested.items[12][0].some-field"])("resolves the plain attribute path %s", (attribute) => {
    expect(resolve(attribute, primary).value).toBe(`\${aws_vpc.network_main.${attribute}}`);
  });

  it("uses a referenced node's primary data address", () => {
    expect(resolve("id", { addresses: ["data.aws_vpc.network_main"] }, { target: { ownership: "referenced" } }).value).toBe("${data.aws_vpc.network_main.id}");
  });

  it("retains the primary matching-label and first-resource fallback rules", () => {
    expect(resolve("id", { addresses: ["aws_subnet.aux", "aws_vpc.network_main"] }).value).toBe("${aws_vpc.network_main.id}");
    expect(resolve("id", { addresses: ["data.aws_vpc.aux", "aws_vpc.primary"] }).value).toBe("${aws_vpc.primary.id}");
  });

  it.each(["", "target_group_arn:missing", "a..b", ".id", "0", "id[foo]", "id[*]", 'id["key"]', "id[]", "id[0", "id]", "id\n", "id\r", "id;file(x)", '${file("canary")}', "id} ${file(x)}", "id%{if}", "id/other", "a".repeat(513)])("refuses invalid or unpublished reference %j", (attribute) => {
    // Even a declared normalized name cannot make invalid syntax acceptable.
    const invalidSyntax = /[\s;$"{}%()*]/.test(attribute) || attribute.length > 512;
    const fragment = invalidSyntax ? { ...primary, locals: { [refLocalName(target, attribute)]: "value" } } : primary;
    expect(() => resolve(attribute, fragment)).toThrow(StepFailedError);
  });

  it("refuses an external target, even if its driver could publish an id", () => {
    expect(() => resolve("id", primary, { target: { ownership: "external" } })).toThrow(/service\/web references network\/main with attribute "id".*no OpenTofu address/);
  });

  it("names the source, target and attribute when the target is absent", () => {
    expect(() => resolve("id", primary, { missingTarget: true })).toThrow(/service\/web references network\/main.*attribute reference "id"/);
  });

  it("refuses a target without an address and a malicious primary traversal", () => {
    expect(() => resolve("id", { addresses: [] })).toThrow(StepFailedError);
    expect(() => resolve("id", { addresses: ['aws_vpc.main} ${file("canary")}'] })).toThrow(StepFailedError);
  });

  it("bounds and sanitizes every identifier in a refusal", () => {
    let failure: unknown;
    try { resolve("bad\n" + "x".repeat(1000), primary, { source: source + "\n" + "y".repeat(1000) }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(StepFailedError);
    const message = (failure as Error).message;
    expect(message).toContain("service/web");
    expect(message).toContain(target);
    expect(message).toContain("bad");
    expect(message).not.toMatch(/[\r\n]/);
    expect(message.length).toBeLessThan(400);
  });

  it("keeps cycles an error before a local can be used", () => {
    const graph: ResourceGraph = { version: 1, environmentId: "env-ref", manifestDigest: "m", graphDigest: "g", notes: [], edges: [], nodes: [node(source), node(target)] };
    const compile = (other: string) => (_: ResourceNode, ctx: CompileContext): TofuFragment => ({ addresses: [], locals: { [refLocalName(other, "id")]: ctx.ref(other, "id") } });
    const drivers = new Map([[source, driver(source, compile(target))], [target, driver(target, compile(source))]]);
    expect(() => compileGraph({ graph, environmentId: graph.environmentId, region: "us-east-1", tags: {}, drivers: (_, type) => drivers.get(type) })).toThrow(/cycle: service\/web → network\/main → service\/web/);
  });

  it("returns only one safe local or resource interpolation", () => {
    for (const attribute of ["id", "metadata[0].name"]) {
      expect(resolve(attribute, primary).value).toMatch(/^\$\{aws_vpc\.network_main\.[A-Za-z0-9_.[\]-]+\}$/);
    }
    // A published value can be complex; ctx.ref returns only its local name.
    expect(resolve("id", { ...primary, locals: { [refLocalName(target, "id")]: "manifest text ${a.b.c} ${d.e.f}" } }).value).toMatch(/^\$\{local\.[a-z0-9_]+\}$/);
  });
});
