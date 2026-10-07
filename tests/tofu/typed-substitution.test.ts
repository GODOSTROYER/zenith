/**
 * Generic substitution of cross-partition references against REAL OpenTofu (built-in terraform_data with a local backend; no cloud, no
 * network). The substitution layer is the production one (graph pass, compile-layer placeholders, workspace variables); the driver is a
 * labelled synthetic one that copies a node's spec into the resource, standing for any driver that renders manifest fields. Proves that
 * a producer's output (an Azure Postgres host, an AWS function URL) reaches a consumer's env values, URLs, connection strings and
 * allowlists through the declared variables, and that a secret in a non-secret field is refused before tofu is ever started.
 * Skipped, with the reason in the suite name, only when no tofu binary is on PATH / ZENITH_TOFU_BIN.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResourceDriver } from "@/lib/drivers/types";
import { compileGraph } from "@/lib/execution/compile";
import { applyTypedInputsToGraph } from "@/lib/execution/typed-substitution";
import type { ConsumedInput } from "@/lib/execution/typed-inputs";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { applyVerifiedPlan, planWorkspace } from "@/lib/tofu/engine";
import { TofuRunner } from "@/lib/tofu/runner";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { tempDir, tofuOnPath } from "./_helpers";

const hasTofu = tofuOnPath();
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const PG_HOST = "pg-prod.postgres.database.azure.com";
const FN_URL = "https://abc123.lambda-url.us-east-1.on.aws/";
const h = (c: string): string => c.repeat(64);
const inputs: ConsumedInput[] = [
  { name: "fn_url", referenceId: "r1", type: "endpoint", valueDigest: h("a"), value: FN_URL },
  { name: "pg_host", referenceId: "r2", type: "endpoint", valueDigest: h("b"), value: PG_HOST },
  { name: "db_conn", referenceId: "r3", type: "secret_ref", valueDigest: h("c"), secret: { ref: "vault:proj_1/mixabc123/outdef456", versionDigest: h("d") } },
];
const mark = (name: string): string => `{{zenith.input.${name}}}`;

const driver: ResourceDriver = {
  id: "test.copy_spec@1", provider: "aws", nativeType: "test:copy_spec", kind: "provider_native",
  capabilities: { compile: true, observe: false, runtime: false, verify: false, discover: false, operations: [], evidence: { compile: "simulated" } },
  compile: (node) => ({
    resource: { terraform_data: { consumer: { input: { env: node.spec.env, url: node.spec.url, allow: node.spec.allow } } } },
    output: { rendered: { value: "${terraform_data.consumer.input}" } },
    addresses: ["terraform_data.consumer"],
  }),
};

function consumer(spec: Record<string, unknown>): ResourceGraph {
  const node: ResourceNode = { address: "service/consumer", kind: "provider_native", provider: "aws", region: "ap-south-1", nativeType: "test:copy_spec", ownership: "managed", spec, origin: [], dependsOn: [], specDigest: h("0"), labels: {} };
  return { version: 1, environmentId: "env_1", manifestDigest: "m".repeat(8), nodes: [node], edges: [], graphDigest: "g".repeat(8), notes: [] };
}

function render(spec: Record<string, unknown>, statePath: string) {
  const graph = applyTypedInputsToGraph(consumer(spec), inputs);
  const compiled = compileGraph({ graph, environmentId: "env_1", region: "ap-south-1", tags: {}, drivers: () => driver, inputs });
  const declared = inputs.filter((item) => item.secret === undefined || compiled.usedInputs.has(item.name));
  return assembleWorkspace({
    graph, fragments: compiled.fragments, providerSet: "builtin", region: "ap-south-1", backend: { kind: "local", path: statePath }, tags: {},
    inputs: declared.map((item) => ({ name: item.name, type: "string" as const, sensitive: item.secret !== undefined, ...(item.secret === undefined ? { value: item.value as string } : {}) })),
  });
}

describe("references that cannot be placed never reach tofu", () => {
  it("refuses a secret input in an env value, a URL or an allowlist before any workspace exists", () => {
    const state = "/tmp/never-used/terraform.tfstate";
    for (const spec of [{ env: [{ key: "K", value: mark("db_conn") }] }, { url: `https://${mark("db_conn")}/` }, { allow: [mark("db_conn")] }]) {
      expect(() => render(spec, state)).toThrow(/not a secret reference/);
    }
  });
});

describe.skipIf(!hasTofu)("manifest references reach resources through declared variables (real tofu 1.12.5, local backend)", () => {
  const runner = new TofuRunner({ limits: { timeoutMs: 120_000 } });

  it("renders the AWS function URL and the Azure host into env values, a URL, a connection string and an allowlist", async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const state = path.join(t.dir, "state", "terraform.tfstate");
    const ws = render({
      env: [{ key: "UPSTREAM", value: mark("fn_url") }, { key: "PG_URL", value: `postgres://app@${mark("pg_host")}:5432/db?sslmode=require` }, { key: "LITERAL", value: "unchanged" }],
      url: `${mark("fn_url")}health`,
      allow: [mark("fn_url"), mark("pg_host")],
    }, state);
    // declared as non-secret variable defaults: part of the configuration digest, never a secret variable
    const main = JSON.parse(ws.files.find((f) => f.path === "main.tf.json")!.content) as { variable: Record<string, unknown> };
    expect(main.variable).toEqual({ zenith_in_fn_url: { type: "string", default: FN_URL }, zenith_in_pg_host: { type: "string", default: PG_HOST } });

    const planned = await planWorkspace(ws, undefined, { runner });
    const applied = await applyVerifiedPlan(ws, { approvedDigest: planned.plan.planDigest, runner });
    expect(applied.outputs.rendered.value).toEqual({
      env: [{ key: "UPSTREAM", value: FN_URL }, { key: "PG_URL", value: `postgres://app@${PG_HOST}:5432/db?sslmode=require` }, { key: "LITERAL", value: "unchanged" }],
      url: `${FN_URL}health`,
      allow: [FN_URL, PG_HOST],
    });
  }, 240_000);

  it("a changed producer value changes the configuration digest, so the reviewed plan no longer applies", async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const state = path.join(t.dir, "state", "terraform.tfstate");
    const spec = { env: [{ key: "UPSTREAM", value: mark("fn_url") }] };
    const before = render(spec, state);
    inputs[0] = { ...inputs[0], value: "https://zzz999.lambda-url.us-east-1.on.aws/" };
    try {
      const after = render(spec, state);
      expect(after.configDigest).not.toBe(before.configDigest);
      const planned = await planWorkspace(before, undefined, { runner });
      await expect(applyVerifiedPlan(after, { approvedDigest: planned.plan.planDigest, runner })).rejects.toMatchObject({ code: "plan_changed" });
    } finally {
      inputs[0] = { ...inputs[0], value: FN_URL };
    }
  }, 240_000);
});
