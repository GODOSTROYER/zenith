/**
 * Typed delivery of producer outputs into a mixed consumer (PROD-MIX follow-up, round 2), at contract level: the consumer's
 * compiler context, the workspace variables, the secret non-disclosure properties of the rendered files, and the consumer's
 * semantics digest (DUR-B). No cloud API is called and no tofu process is started here; the real OpenTofu proof (variables,
 * the sensitive input channel, output capture) is tests/tofu/typed-inputs.test.ts, gated on a tofu binary.
 */
import { describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import type { CompileContext, ResourceDriver } from "@/lib/drivers/types";
import { compileGraph } from "@/lib/execution/compile";
import { StepFailedError } from "@/lib/execution/errors";
import {
  computeExecutableSemantics, diffSemantics, normalizedComponent, type ExecutableSemanticsInputs,
} from "@/lib/execution/semantics/digest";
import { digestOfInputs, inputEnvName, inputVariable, semanticsOfInputs, type ConsumedInput } from "@/lib/execution/typed-inputs";
import { outputNameFor } from "@/lib/execution/mixed/typed-inputs";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { assembleWorkspace, TofuWorkspaceError } from "@/lib/tofu/workspace";
import { builtinWorkspaceInput } from "./typed-delivery-support";

const h = (c: string): string => c.repeat(64);
const HOST: ConsumedInput = { name: "endpoint_db", referenceId: "db-host", type: "endpoint", valueDigest: digest({ type: "endpoint", value: "db.internal.example" }), value: "db.internal.example" };
const SECRET: ConsumedInput = {
  name: "db_password", referenceId: "db-secret", type: "secret_ref", valueDigest: h("a"), secret: { ref: "vault:proj/mixabc/outdef", versionDigest: h("b") },
};

function node(address: string): ResourceNode {
  return { address, provider: "aws", nativeType: address, kind: "provider_native", ownership: "managed", region: "us-east-1", spec: {}, specDigest: "0".repeat(64), origin: [], dependsOn: [], labels: {} };
}

function compileWith(inputs: readonly ConsumedInput[] | undefined, ask: (ctx: CompileContext) => string) {
  const address = "service/web";
  const driver: ResourceDriver = {
    id: "test.web", provider: "aws", nativeType: address, kind: "provider_native",
    capabilities: { compile: true, observe: false, runtime: false, verify: false, discover: false, operations: [], evidence: { compile: "simulated" } },
    compile: (_, ctx) => ({ locals: { dependency: ask(ctx) }, addresses: [] }),
  };
  const graph: ResourceGraph = { version: 1, environmentId: "env-typed", manifestDigest: "m", graphDigest: "g", notes: [], edges: [], nodes: [node(address)] };
  return compileGraph({ graph, environmentId: graph.environmentId, region: "us-east-1", tags: {}, drivers: () => driver, ...(inputs ? { inputs } : {}) }).fragments.get(address)!;
}

describe("the consumer's compiler context", () => {
  it("hands a declared input to a driver as the interpolation of its zenith_in_ variable, never as a value", () => {
    const fragment = compileWith([HOST, SECRET], (ctx) => `${ctx.input!("endpoint_db")}:${ctx.input!("db_password")}`);
    expect(fragment.locals!.dependency).toBe("${var.zenith_in_endpoint_db}:${var.zenith_in_db_password}");
    expect(JSON.stringify(fragment)).not.toContain("db.internal.example");
  });

  it("refuses an input this operation does not consume, and every input of an operation that consumes none", () => {
    expect(() => compileWith([HOST], (ctx) => ctx.input!("other_input"))).toThrow(StepFailedError);
    expect(() => compileWith(undefined, (ctx) => ctx.input!("endpoint_db"))).toThrow(StepFailedError);
    expect(() => compileWith([], (ctx) => ctx.input!("endpoint_db"))).toThrow(StepFailedError);
  });

  it("names the variable and the child environment variable from the input name alone", () => {
    expect(inputVariable("endpoint_db")).toBe("zenith_in_endpoint_db");
    expect(inputEnvName("db_password")).toBe("TF_VAR_zenith_in_db_password");
  });
});

describe("the workspace variables", () => {
  const withInputs = (inputs: Parameters<typeof builtinWorkspaceInput>[0]) => assembleWorkspace(builtinWorkspaceInput(inputs));
  const main = (ws: ReturnType<typeof assembleWorkspace>) => JSON.parse(ws.files.find((f) => f.path === "main.tf.json")!.content);

  it("declares a non-secret input with its value as the default, so the value is part of the configuration digest", () => {
    const a = withInputs([{ name: "endpoint_db", type: "string", sensitive: false, value: "db-a.internal" }]);
    const b = withInputs([{ name: "endpoint_db", type: "string", sensitive: false, value: "db-b.internal" }]);
    expect(main(a).variable.zenith_in_endpoint_db).toEqual({ type: "string", default: "db-a.internal" });
    expect(a.configDigest).not.toBe(b.configDigest);
    expect(withInputs(undefined).configDigest).not.toBe(a.configDigest);
  });

  it("declares a secret input as sensitive with NO default: no file of the workspace can contain its value", () => {
    const ws = withInputs([{ name: "db_password", type: "string", sensitive: true }]);
    expect(main(ws).variable.zenith_in_db_password).toEqual({ type: "string", sensitive: true });
    expect(JSON.stringify(main(ws).variable)).not.toContain("default");
  });

  it("types numbers and booleans, and refuses a mistyped, duplicated, misnamed or secret-with-value input", () => {
    expect(main(withInputs([{ name: "replicas", type: "number", sensitive: false, value: 3 }, { name: "tls", type: "boolean", sensitive: false, value: true }])).variable).toEqual({
      zenith_in_replicas: { type: "number", default: 3 }, zenith_in_tls: { type: "bool", default: true },
    });
    const refused = (inputs: Parameters<typeof builtinWorkspaceInput>[0]) => expect(() => withInputs(inputs)).toThrow(TofuWorkspaceError);
    refused([{ name: "replicas", type: "number", sensitive: false, value: "3" as never }]);
    refused([{ name: "x", type: "string", sensitive: false }]);
    refused([{ name: "Bad-Name", type: "string", sensitive: false, value: "v" }]);
    refused([{ name: "x", type: "string", sensitive: false, value: "a" }, { name: "x", type: "string", sensitive: false, value: "b" }]);
    refused([{ name: "x", type: "string", sensitive: true, value: "leak" }]);
  });

  it("leaves a workspace without inputs byte-identical (no variable block)", () => {
    expect(main(withInputs(undefined)).variable).toBeUndefined();
  });
});

describe("the consumer's semantics digest (DUR-B)", () => {
  function base(typedInputs?: ReturnType<typeof semanticsOfInputs>): ExecutableSemanticsInputs {
    return {
      revision: { id: "rev_1", deployedRevisionId: null, manifestDigest: h("1") }, recipe: { executableSourceDigest: null, sources: [] }, scripts: { release: null }, migrations: null,
      targets: { graphDigest: h("a"), provider: "aws", region: "us-east-1", environmentId: "env_1", connectionId: "conn_1", connectionConfigDigest: h("b") },
      configuration: { configDigest: h("c"), ...(typedInputs ? { typedInputs } : {}) }, providerLocks: { lockDigest: h("d"), tofuVersion: "1.12.5" }, backend: { kind: "s3", configDigest: h("e") },
      savedPlan: { planDigest: h("f") }, provenance: { pipelines: [] }, ownership: { transfers: [] }, runbook: null, decommission: { adoptions: [] },
    };
  }

  it("is byte-identical for an operation that consumes nothing (no new field in the component)", () => {
    expect(normalizedComponent("configuration", base())).toEqual({ configDigest: h("c") });
    expect(normalizedComponent("configuration", base([]))).toEqual({ configDigest: h("c") });
    expect(computeExecutableSemantics(base()).digest).toBe(computeExecutableSemantics(base([])).digest);
  });

  it("moves the configuration component when a consumed output digest changes, naming that component only", () => {
    const approved = computeExecutableSemantics(base(semanticsOfInputs([HOST, SECRET])));
    const changedValue = computeExecutableSemantics(base(semanticsOfInputs([{ ...HOST, valueDigest: digest({ type: "endpoint", value: "db.other.example" }), value: "db.other.example" }, SECRET])));
    expect(changedValue.digest).not.toBe(approved.digest);
    expect(diffSemantics(approved, changedValue)).toEqual(["configuration"]);
  });

  it("moves it when a secret's version digest changes (a rotated vault entry invalidates the approval) or an input is added or removed", () => {
    const approved = computeExecutableSemantics(base(semanticsOfInputs([HOST, SECRET])));
    const rotated = computeExecutableSemantics(base(semanticsOfInputs([HOST, { ...SECRET, secret: { ref: SECRET.secret!.ref, versionDigest: h("c") } }])));
    expect(diffSemantics(approved, rotated)).toEqual(["configuration"]);
    expect(diffSemantics(approved, computeExecutableSemantics(base(semanticsOfInputs([HOST]))))).toEqual(["configuration"]);
    expect(diffSemantics(computeExecutableSemantics(base()), approved)).toEqual(["configuration"]);
  });

  it("does not depend on the order inputs were loaded in, and carries only names, types and digests", () => {
    const a = computeExecutableSemantics(base(semanticsOfInputs([HOST, SECRET])));
    const b = computeExecutableSemantics(base(semanticsOfInputs([SECRET, HOST])));
    expect(a.digest).toBe(b.digest);
    const text = JSON.stringify(semanticsOfInputs([HOST, SECRET]));
    expect(text).not.toContain("db.internal.example");
    expect(digestOfInputs([HOST, SECRET])).toBe(digestOfInputs([SECRET, HOST]));
  });
});

describe("which tofu output carries a reference", () => {
  it("prefers the driver-namespaced name and falls back to the bare output name", () => {
    expect(outputNameFor(["resource_db_endpoint", "endpoint"], "resource/db", "endpoint")).toBe("resource_db_endpoint");
    expect(outputNameFor(["endpoint"], "resource/db", "endpoint")).toBe("endpoint");
    expect(outputNameFor(["other"], "resource/db", "endpoint")).toBeUndefined();
  });
});
