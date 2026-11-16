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

function resolve(attribute: string, fragment: TofuFragment, options: { target?: Partial<ResourceNode>; source?: string; missingTarget?: boolean; missingDriver?: boolean } = {}) {
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
  const compiled = compileGraph({ graph, environmentId: graph.environmentId, region: "us-east-1", tags: {}, drivers: (_, type) => type === target && options.missingDriver ? undefined : drivers.get(type) });
  return { value: compiled.fragments.get(sourceAddress)!.locals!.resolved, calls };
}

const primary: TofuFragment = { addresses: ["aws_vpc.network_main"] };

function compileSource(compile: NonNullable<ResourceDriver["compile"]>, reverse = false) {
  const graph: ResourceGraph = { version: 1, environmentId: "env-ref", manifestDigest: "m", graphDigest: "g", notes: [], edges: [], nodes: (reverse ? [target, source] : [source, target]).map((address) => node(address)) };
  const drivers = new Map([[source, driver(source, compile)], [target, driver(target, () => primary)]]);
  return compileGraph({ graph, environmentId: graph.environmentId, region: "us-east-1", tags: {}, drivers: (_, type) => drivers.get(type) }).fragments.get(source)!;
}

describe("execution reference resolution", () => {
  it("resolves the target after compilation and prefers its published local over a primary attribute", () => {
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

  it("refuses a referenced target that never compiled because its driver is unavailable", () => {
    expect(() => resolve("id", primary, { target: { ownership: "referenced" }, missingDriver: true })).toThrow(/no OpenTofu address.*driver cannot compile/);
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

  it("compiles reciprocal node references once and resolves both after all fragments exist", () => {
    const graph: ResourceGraph = { version: 1, environmentId: "env-ref", manifestDigest: "m", graphDigest: "g", notes: [], edges: [], nodes: [node(source), node(target)] };
    const calls: string[] = [];
    const compile = (other: string) => (n: ResourceNode, ctx: CompileContext): TofuFragment => {
      calls.push(n.address);
      const reference = ctx.ref(other, "id");
      expect(calls[calls.length - 1]).toBe(n.address); // ref never invokes the target
      return { addresses: [n.address === source ? "aws_subnet.service_web" : "aws_vpc.network_main"],
        locals: { [refLocalName(n.address, "id")]: n.address === source ? "${aws_subnet.service_web.id}" : "${aws_vpc.network_main.id}", neighbour: reference } };
    };
    const drivers = new Map([[source, driver(source, compile(target))], [target, driver(target, compile(source))]]);
    const result = compileGraph({ graph, environmentId: graph.environmentId, region: "us-east-1", tags: {}, drivers: (_, type) => drivers.get(type) });
    expect(calls).toEqual([source, target]);
    expect(result.fragments.get(source)!.locals!.neighbour).toBe("${local.ref_network_main__id}");
    expect(result.fragments.get(target)!.locals!.neighbour).toBe("${local.ref_service_web__id}");
  });

  it("returns only one safe local or resource interpolation", () => {
    for (const attribute of ["id", "metadata[0].name"]) {
      expect(resolve(attribute, primary).value).toMatch(/^\$\{aws_vpc\.network_main\.[A-Za-z0-9_.[\]-]+\}$/);
    }
    // A published value can be complex; ctx.ref returns only its local name.
    expect(resolve("id", { ...primary, locals: { [refLocalName(target, "id")]: "manifest text ${a.b.c} ${d.e.f}" } }).value).toMatch(/^\$\{local\.[a-z0-9_]+\}$/);
  });
});

describe("two-phase reference substitution", () => {
  it("uses unique provisional tokens and substitutes all keys, values and arrays", () => {
    const fragment = compileSource((_, ctx) => {
      const first = ctx.ref(target, "id");
      const second = ctx.ref(target, "id");
      expect(first).toMatch(/^\$\{__zenith_ref_[0-9]+__\}$/);
      expect(second).not.toBe(first);
      return { addresses: [], output: { [first]: { value: { [second]: [first, null, 123, true] } } }, locals: { suffix: `prefix:${second}:suffix` } };
    });
    const ref = "${aws_vpc.network_main.id}";
    expect(fragment).toEqual({ addresses: [], output: { [ref]: { value: { [ref]: [ref, null, 123, true] } } }, locals: { suffix: `prefix:${ref}:suffix` } });
    expect(JSON.stringify(fragment)).not.toContain("__zenith_ref_");
  });

  it("resolves bare tokens inside expressions but preserves escaped and literal copies", () => {
    const fragment = compileSource((_, ctx) => {
      const ref = ctx.ref(target, "id");
      const bare = ref.slice(2, -1);
      return { addresses: [], locals: {
        mixed: `${ref} literal ${bare} escaped $${ref}`,
        nested: '${jsonencode({id = ' + bare + ', text = "$${' + bare + '}"})}',
        comment: '${/* ' + bare + ' */ ' + bare + '}',
        heredoc: '${join("", [<<EOT\n$${' + bare + '}\nEOT\n, ' + bare + '])}',
      } };
    });
    expect(fragment.locals).toEqual({
      mixed: "${aws_vpc.network_main.id} literal __zenith_ref_0__ escaped $${__zenith_ref_0__}",
      nested: '${jsonencode({id = aws_vpc.network_main.id, text = "$${__zenith_ref_0__}"})}',
      comment: "${/* __zenith_ref_0__ */ aws_vpc.network_main.id}",
      heredoc: '${join("", [<<EOT\n$${__zenith_ref_0__}\nEOT\n, aws_vpc.network_main.id])}',
    });
  });

  it("leaves escaped manifest text intact even without any issued references", () => {
    expect(compileSource(() => ({ addresses: [], locals: { literal: "$${__zenith_ref_0__}" } })).locals).toEqual({ literal: "$${__zenith_ref_0__}" });
  });

  it.each(["${__zenith_ref_99__}", "${__zenith_ref_corrupt__}", "${__zenith_ref_0__"])("fails closed on an unissued or malformed token template %s", (text) => {
    expect(() => compileSource((_, ctx) => {
      ctx.ref(target, "id");
      return { addresses: [], locals: { bad: text } };
    })).toThrow(StepFailedError);
  });

  it("refuses colliding keys after replacement", () => {
    expect(() => compileSource((_, ctx) => ({ addresses: [], locals: { [ctx.ref(target, "id")]: 1, [ctx.ref(target, "id")]: 2 } }))).toThrow(/duplicate keys/);
  });

  it("checks references even when the compiler discards their tokens", () => {
    expect(() => compileSource((_, ctx) => {
      ctx.ref(target, "target_group_arn:missing");
      return { addresses: [] };
    })).toThrow(/unpublished attribute reference/);
  });

  it("never widens an external target into a guessed reference", () => {
    expect(() => resolve("target_group_arn:web", primary, { target: { ownership: "external" } })).toThrow(/no OpenTofu address/);
  });

  it("does not depend on node compilation order", () => {
    const compile = (_: ResourceNode, ctx: CompileContext): TofuFragment => ({ addresses: [], locals: { first: ctx.ref(target, "id"), second: ctx.ref(target, "arn") } });
    expect(compileSource(compile)).toEqual(compileSource(compile, true));
  });
});
