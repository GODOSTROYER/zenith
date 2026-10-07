/**
 * Generic substitution of cross-partition references in manifest fields (PROD-MIX follow-up, round 3), at contract level with REAL
 * drivers: a secret input becomes the provider's own secret reference (GCP Cloud Run `secret_key_ref` over a managed vault secret
 * node), a non-secret input becomes the typed variable expression inside env values, URLs, connection strings and allowlists, and
 * every reference a field cannot take is refused at plan time. The real OpenTofu proof is tests/tofu/typed-substitution.test.ts. No
 * cloud API is called; the drivers only render configuration.
 */
import { describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import type { ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import { compileGraph } from "@/lib/execution/compile";
import { StepFailedError } from "@/lib/execution/errors";
import { placeholdersIn, rewriteSpecMarkers, substituteInputTokens, applyTypedInputsToGraph } from "@/lib/execution/typed-substitution";
import type { ConsumedInput } from "@/lib/execution/typed-inputs";
import { gcpDrivers } from "@/lib/providers/gcp/drivers";
import { lambdaFunctionDriver } from "@/lib/providers/aws/drivers/compute/lambda-function";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { buildFullFixture, mkCompileContext } from "../../providers/aws/drivers/compute/fixtures";
import { TAGS, environmentNodes, graphOf, mk, REGION } from "../../providers/gcp/_fixtures";

const h = (c: string): string => c.repeat(64);
const CONN_REF = "vault:proj_1/mixabc123/outdef456";
const PG_HOST = "pg-prod.postgres.database.azure.com";
const FN_URL = "https://abc123.lambda-url.us-east-1.on.aws/";
const input = (name: string, type: ConsumedInput["type"], over: Partial<ConsumedInput> = {}): ConsumedInput => ({
  name, referenceId: `ref-${name}`, type, valueDigest: h("a"), ...(type === "secret_ref" ? { secret: { ref: CONN_REF, versionDigest: h("b") } } : { value: "v" }), ...over,
});
const DB_CONN = input("db_conn", "secret_ref");
const PG = input("pg_host", "endpoint", { value: PG_HOST });
const FN = input("fn_url", "endpoint", { value: FN_URL });
const ALL = [DB_CONN, PG, FN];
const MARK = (name: string): string => `{{zenith.input.${name}}}`;

const gcpLookup = (_provider: string, nativeType: string): ResourceDriver | undefined => gcpDrivers.find((driver) => driver.nativeType === nativeType) as ResourceDriver | undefined;

/** The GCP environment graph with a Cloud Run consumer whose env holds references to an Azure Postgres and an AWS function URL. */
function consumerNodes(env: Record<string, unknown>[] = [], over: { secretNode?: boolean } = {}): ResourceNode[] {
  const nodes = environmentNodes().filter((node) => ["network/main", "subnet/private-a"].includes(node.address));
  const secretNode = over.secretNode === false ? [] : [mk("secret/db-conn", "secret", { secretRef: MARK("db_conn"), store: "provider_secret_manager", purpose: "environment" }, [], { ownership: "referenced", externalRef: MARK("db_conn") })];
  const service = mk("service/web", "container_service", {
    size: "small", vcpu: 1, memoryMb: 512, artifact: { type: "image", ref: `${REGION}-docker.pkg.dev/acme-prod-123456/web/app@sha256:${"a".repeat(64)}` },
    env: [{ key: "NODE_ENV", value: "production" }, ...env], zones: 1, subnetTier: "private", workload: "web", replicas: 1, port: 3000, healthPath: "/healthz",
  }, ["network/main", "subnet/private-a", ...(secretNode.length ? ["secret/db-conn"] : [])]);
  return [...nodes, ...secretNode, service];
}

function compileGcp(env: Record<string, unknown>[], inputs: readonly ConsumedInput[], secretNode = true) {
  const prepared = applyTypedInputsToGraph(graphOf(consumerNodes(env, { secretNode })), inputs);
  const compiled = compileGraph({ graph: prepared, environmentId: "env_1", region: REGION, tags: TAGS, drivers: gcpLookup, ...(inputs.length ? { inputs } : {}) });
  return { prepared, compiled };
}

describe("a secret reference from another partition (Azure PG connection string into a GCP Cloud Run env var)", () => {
  const env = [{ key: "DATABASE_URL", secretRef: MARK("db_conn") }];

  it("becomes the vault reference the producer sealed, on a managed vault secret node, so the provider's own secret path delivers it", () => {
    const { prepared, compiled } = compileGcp(env, ALL);
    const secret = prepared.nodes.find((node) => node.address === "secret/db-conn")!;
    expect(secret.spec).toMatchObject({ secretRef: CONN_REF, store: "zenith_vault" });
    expect(secret.ownership).toBe("managed");
    expect(secret.externalRef).toBeUndefined();
    expect(secret.specDigest).toMatch(/^[a-f0-9]{64}$/);
    const web = prepared.nodes.find((node) => node.address === "service/web")!;
    expect((web.spec as { env: { key: string; secretRef?: string }[] }).env.find((entry) => entry.key === "DATABASE_URL")).toEqual({ key: "DATABASE_URL", secretRef: CONN_REF });
    // the Cloud Run driver's own mechanism: Secret Manager secret_key_ref, never an inline value
    const fragment = JSON.stringify(compiled.fragments.get("service/web"));
    expect(fragment).toContain("secret_key_ref");
    expect(fragment).toContain("DATABASE_URL");
    expect(fragment).not.toContain("{{zenith");
    expect(fragment).not.toContain("zenith_in_db_conn");
    // no variable is declared for a secret delivered through the secret path
    expect(compiled.usedInputs.has("db_conn")).toBe(false);
  });

  it("changes the graph digest (so plan custody and the semantics digest see it) and leaves a graph without markers untouched", () => {
    const plain = graphOf(environmentNodes());
    expect(applyTypedInputsToGraph(plain, ALL)).toBe(plain);
    expect(applyTypedInputsToGraph(plain, [])).toBe(plain);
    const before = graphOf(consumerNodes(env));
    const after = applyTypedInputsToGraph(before, ALL);
    expect(after.graphDigest).not.toBe(before.graphDigest);
    expect(JSON.stringify(after)).not.toContain("{{zenith");
  });

  it("is refused where the field is not a secret reference, and where the input is not a secret", () => {
    expect(() => compileGcp([{ key: "DATABASE_URL", value: MARK("db_conn") }], ALL, false)).toThrow(/not a secret reference/);
    expect(() => compileGcp([{ key: "DATABASE_URL", value: `postgres://app@${MARK("db_conn")}/db` }], ALL, false)).toThrow(/not a secret reference/);
    expect(() => compileGcp([{ key: "DATABASE_URL", secretRef: MARK("pg_host") }], ALL, false)).toThrow(/is not a secret/);
    expect(() => compileGcp([{ key: "DATABASE_URL", secretRef: `prefix-${MARK("db_conn")}` }], ALL, false)).toThrow(/exactly the secret input reference/);
  });
});

describe("a non-secret reference from another partition (AWS function URL / Azure host into a consumer env var)", () => {
  it("becomes the typed variable expression inside an env value, a URL and a connection string, whatever else surrounds it", () => {
    const { compiled } = compileGcp([
      { key: "UPSTREAM", value: MARK("fn_url") },
      { key: "PG_URL", value: `postgres://app@${MARK("pg_host")}:5432/db?sslmode=require` },
      { key: "ALLOWED", value: `${MARK("fn_url")},${MARK("pg_host")}` },
    ], ALL, false);
    const fragment = JSON.stringify(compiled.fragments.get("service/web"));
    expect(fragment).toContain("${var.zenith_in_fn_url}");
    expect(fragment).toContain("postgres://app@${var.zenith_in_pg_host}:5432/db?sslmode=require");
    expect(fragment).toContain("${var.zenith_in_fn_url},${var.zenith_in_pg_host}");
    expect(fragment).not.toContain("{{zenith");
    expect(fragment).not.toContain("__zenith_in_");
    expect([...compiled.usedInputs].sort()).toEqual(["fn_url", "pg_host"]);
    // the value itself is never inlined into the rendered configuration by the substitution
    expect(fragment).not.toContain(PG_HOST);
    expect(fragment).not.toContain(FN_URL);
  });

  it("works for the AWS Lambda driver too: the URL reaches a function env var; a secret there is the driver's own refusal", () => {
    const fx = buildFullFixture();
    const withEnv = (env: unknown): ResourceNode => ({ ...fx.fn, spec: { ...fx.fn.spec, env } as ResourceNode["spec"] });
    const names = ["fn_url", "pg_host"];
    const inputs = new Map([[FN.name, FN], [PG.name, PG]]);
    const indexOf = new Map(names.map((name, index) => [name, index]));
    const rewrite = rewriteSpecMarkers(withEnv([{ key: "UPSTREAM", value: `${MARK("fn_url")}health` }, { key: "PG", value: MARK("pg_host") }]), inputs, indexOf);
    const fragment = lambdaFunctionDriver.compile!(rewrite.node, mkCompileContext(fx.byAddress));
    const seen = new Set<number>();
    const substituted = substituteInputTokens(fragment, "function/resize", names, seen) as TofuFragment;
    expect(JSON.stringify(substituted)).toContain("${var.zenith_in_fn_url}health");
    expect(JSON.stringify(substituted)).toContain("${var.zenith_in_pg_host}");
    expect([...seen].sort()).toEqual([0, 1]);
    // Lambda cannot take a secret reference: the driver refuses the node at plan time
    expect(() => lambdaFunctionDriver.compile!(withEnv([{ key: "PG", secretRef: CONN_REF }]), mkCompileContext(fx.byAddress))).toThrow(/secret reference/);
  });
});

describe("references that cannot be placed are refused at plan time", () => {
  it("a name the operation does not consume (including every marker of an operation that consumes nothing)", () => {
    expect(() => compileGcp([{ key: "X", value: MARK("unknown_input") }], ALL, false)).toThrow(StepFailedError);
    expect(() => compileGcp([{ key: "X", value: MARK("fn_url") }], [], false)).toThrow(/does not consume/);
    expect(() => applyTypedInputsToGraph(graphOf(consumerNodes([{ key: "X", value: MARK("fn_url") }], { secretNode: false })), [])).toThrow(/does not consume/);
  });

  it("a malformed marker, a marker in an object key", () => {
    expect(() => compileGcp([{ key: "X", value: "{{zenith.input.Bad-Name}}" }], ALL, false)).toThrow(/malformed/);
    expect(() => applyTypedInputsToGraph(graphOf([mk("service/web", "container_service", { labels: { [MARK("fn_url")]: "x" } })]), ALL)).toThrow(/object key/);
  });

  it("a field the driver does not carry into the resource it renders (the reference would silently vanish)", () => {
    const dropper: ResourceDriver = {
      id: "test.dropper", provider: "gcp", nativeType: "test:dropper", kind: "provider_native",
      capabilities: { compile: true, observe: false, runtime: false, verify: false, discover: false, operations: [], evidence: { compile: "simulated" } },
      compile: () => ({ resource: { terraform_data: { dropper: { input: "static" } } }, addresses: ["terraform_data.dropper"] }),
    };
    const node: ResourceNode = { address: "resource/x", kind: "provider_native", provider: "gcp", region: REGION, nativeType: "test:dropper", ownership: "managed", spec: { note: MARK("fn_url") }, origin: [], dependsOn: [], specDigest: h("0"), labels: {} };
    const graph: ResourceGraph = { version: 1, environmentId: "env_1", manifestDigest: "m", graphDigest: "g", notes: [], edges: [], nodes: [node] };
    expect(() => compileGraph({ graph, environmentId: "env_1", region: REGION, tags: {}, drivers: () => dropper, inputs: [FN] })).toThrow(/was not carried/);
  });

  it("a secret marker that reaches the compiler unrewritten, and a placeholder that survives", () => {
    const node = { address: "resource/x", spec: { env: [{ key: "K", value: MARK("db_conn") }] } } as unknown as ResourceNode;
    expect(() => rewriteSpecMarkers(node, new Map([[DB_CONN.name, DB_CONN]]), new Map([["db_conn", 0]]))).toThrow(/not a secret reference/);
    expect(() => substituteInputTokens({ value: "x__zenith_in_9__" }, "resource/x", ["fn_url"], new Set())).toThrow(/unknown typed-input placeholder/);
    expect(placeholdersIn({ a: ["__zenith_in_3__"], b: { c: "x__zenith_in_4__y" } })).toEqual(new Set([3, 4]));
  });

  it("an operation that consumes nothing is untouched: no marker, no change, same graph object", () => {
    const graph = graphOf(consumerNodes([], { secretNode: false }));
    expect(applyTypedInputsToGraph(graph, [])).toBe(graph);
    expect(digest(graph)).toBe(digest(graph));
  });
});

describe("placeholders become the right expression where HCL evaluates them", () => {
  it("a placeholder inside an interpolation becomes the bare variable and a literal one an interpolation", () => {
    const names = ["fn_url"];
    const seen = new Set<number>();
    const out = substituteInputTokens({ a: "${upper(__zenith_in_0__)}", b: "pre-__zenith_in_0__-post" }, "resource/x", names, seen) as Record<string, string>;
    expect(out.a).toBe("${upper(var.zenith_in_fn_url)}");
    expect(out.b).toBe("pre-${var.zenith_in_fn_url}-post");
    expect([...seen]).toEqual([0]);
  });
});
