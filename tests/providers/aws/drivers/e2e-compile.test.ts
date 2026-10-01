/**
 * V1 → V2 → expanded AWS graph → every registered driver → pinned workspace.
 * Default tests are pure compile/contract checks. The opt-in tests run real
 * OpenTofu provider schema validation without any AWS account or credentials.
 */
import { describe, expect, it } from "vitest";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { TofuRunner } from "@/lib/tofu/runner";
import type { NormalizedPlan, PlanResourceChange, TofuWorkspace } from "@/lib/tofu/types";
import { compiled, SECRET_CANARY } from "./_integration";

function mainOf(workspace: TofuWorkspace) {
  return JSON.parse(workspace.files.find((f) => f.path === "main.tf.json")!.content) as {
    resource: Record<string, Record<string, Record<string, unknown>>>;
    data: Record<string, Record<string, Record<string, unknown>>>;
    locals: Record<string, unknown>;
  };
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [k, ...stringsIn(v)]);
  return [];
}

function planOf(workspace: TofuWorkspace): NormalizedPlan {
  const main = mainOf(workspace);
  const changes: PlanResourceChange[] = [];
  for (const [type, bodies] of Object.entries(main.resource)) {
    for (const [label, body] of Object.entries(bodies)) changes.push({ address: `${type}.${label}`, type, providerName: "registry.opentofu.org/hashicorp/aws", action: "create", destroysData: false,
      changes: Object.entries(body).map(([path, value]) => ({ path, before: null, after: path === "policy" ? policyDocument(main, value) : value, sensitive: false, forcesReplacement: false })) });
  }
  return { tofuVersion: "1.12.5", formatVersion: "1.0", configDigest: workspace.configDigest, lockDigest: workspace.lockDigest, planDigest: "compile-only", resourceChanges: changes,
    outputChanges: [], summary: { create: changes.length, update: 0, delete: 0, replace: 0, noop: 0 }, empty: false, diagnostics: [], createdAt: "2026-10-01T00:00:00Z" };
}

/** Inspect generator-owned policy data, without pretending ARNs are resolved. */
function policyDocument(main: ReturnType<typeof mainOf>, value: unknown): { Statement: { Action: string | string[]; Resource: string | string[]; Effect: string }[] } {
  if (typeof value !== "string") throw new Error("expected a compiled policy string");
  const match = /^\$\{data\.aws_iam_policy_document\.([a-z0-9_]+)\.json\}$/.exec(value);
  if (!match) return JSON.parse(value);
  const source = main.data.aws_iam_policy_document[match[1]];
  expect(source, `absent policy source ${match[1]}`).toBeDefined();
  const statements = source.statement as { actions: string[]; resources: string[]; effect: string }[];
  return { Statement: statements.map((s) => ({ Action: s.actions, Resource: s.resources, Effect: s.effect })) };
}

describe.each(["production", "staging"] as const)("complete AWS %s workspace", (envClass) => {
  it("compiles every managed node with no duplicates, secrets or unresolved cross-node references", () => {
    const { graph, workspace } = compiled(envClass);
    expect(graph.nodes.find((n) => n.kind === "dns_zone")?.ownership).toBe("referenced");
    expect(graph.nodes.filter((n) => n.kind === "subnet" && n.spec.tier === "private")).toHaveLength(2);
    const addresses = Object.values(workspace.addressMap).flat();
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(JSON.stringify({ graph, workspace })).not.toContain(SECRET_CANARY);
    const main = mainOf(workspace);
    const definitions = new Set(Object.keys(main.locals).map((k) => `local.${k}`));
    for (const [type, labels] of Object.entries(main.resource)) for (const label of Object.keys(labels)) definitions.add(`${type}.${label}`);
    for (const [type, labels] of Object.entries(main.data)) for (const label of Object.keys(labels)) definitions.add(`data.${type}.${label}`);
    let references = 0;
    for (const text of stringsIn(main)) {
      for (const [, expr] of text.matchAll(/(?<!\$)\$\{([\s\S]*?)\}/g)) {
        for (const [target] of expr.matchAll(/\b(?:local\.[A-Za-z0-9_]+|data\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+|aws_[A-Za-z0-9_]+\.[A-Za-z0-9_]+)/g)) {
          expect(definitions.has(target), `undefined traversal ${target}`).toBe(true);
          references++;
        }
      }
    }
    expect(references).toBeGreaterThan(50);
  });

  it("is deterministic across two complete expansion/compile/assembly passes", () => {
    expect(compiled(envClass).workspace).toEqual(compiled(envClass).workspace);
  });

  it("has no wildcard IAM findings and grants Redis connect on exactly the group and user ARNs", () => {
    const { workspace } = compiled(envClass);
    const facts = extractPlanFacts(planOf(workspace));
    expect(facts.wildcardIam).toEqual([]);
    expect((facts.unresolved ?? []).filter((p) => p.includes("policy"))).toEqual([]);
    const main = mainOf(workspace);
    const policies = Object.values(main.resource.aws_iam_role_policy);
    let cacheGrants = 0;
    let registryTokens = 0;
    for (const body of policies) {
      const document = policyDocument(main, body.policy);
      for (const statement of document.Statement) {
        const actions = [statement.Action].flat();
        const resources = [statement.Resource].flat();
        expect(actions.some((a) => /[*?]/.test(a))).toBe(false);
        if (resources.includes("*")) {
          // AWS cannot scope registry login. This pre-existing compute-driver
          // exception is explicit: repository pull actions remain exact ARNs.
          expect(actions).toEqual(["ecr:GetAuthorizationToken"]);
          expect(resources).toEqual(["*"]);
          registryTokens++;
        }
        if (actions.includes("elasticache:Connect")) {
          expect(resources.sort()).toEqual(["${local.ref_redis_cache__arn}", "${local.ref_redis_cache__iam_user_arn}"].sort());
          expect(resources.join()).not.toMatch(/[*?]/);
          cacheGrants++;
        }
      }
    }
    expect(cacheGrants).toBe(2);
    expect(registryTokens).toBeGreaterThan(0);
  });
});

describe.skipIf(process.env.ZENITH_TEST_TOFU_NETWORK !== "1")("real OpenTofu AWS 6.66.0 schema validation (opt-in)", () => {
  it.each(["production", "staging"] as const)("initializes and validates the %s workspace without a backend or cloud credentials", async (envClass) => {
    const runner = new TofuRunner({ limits: { timeoutMs: 120_000 } });
    await runner.run(compiled(envClass).workspace, {}, async (run) => {
      await run.init({ backend: false });
      const validation = await run.validate();
      expect(validation.diagnostics).toEqual([]);
      expect(validation.valid).toBe(true);
    });
  }, 180_000);
});
