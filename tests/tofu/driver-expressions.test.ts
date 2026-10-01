/**
 * Compile existing provider fixture graphs and inventory their real HCL calls.
 * Compilation is exercised here; this is not evidence of a cloud deployment.
 * Execution's fake drivers emit terraform_data with literal spec digests; the
 * required execution regression run separately covers its injected expressions.
 */
import { describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { COMPUTE_DRIVERS } from "@/lib/providers/aws/drivers/compute";
import { AZURE_DRIVERS } from "@/lib/providers/azure/drivers";
import { expressionRefusal } from "@/lib/tofu/expression-policy";
import { scanHclTemplate } from "@/lib/tofu/hcl-template";
import { compileGraph as awsNetwork } from "../providers/aws/drivers/fixtures/env";
import { fixtureGraph } from "../providers/aws/drivers/fixtures/graph";
import { standardFragments } from "../providers/aws/drivers/data/_helpers";
import { buildFullFixture, mkCompileContext, stubFragments } from "../providers/aws/drivers/compute/fixtures";
import { compileAll as azureCompile, sampleGraph } from "../providers/azure/_helpers";
import { compileContext as gcpCompile, environmentNodes } from "../providers/gcp/_fixtures";
import { compileGraph as ociCompile, expandOci, OCI_PROD, webStack } from "../providers/oci/_support";

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) { out.push(k); strings(v, out); }
  }
  return out;
}

function awsCompute(opts: Parameters<typeof buildFullFixture>[0] = {}): Map<string, TofuFragment> {
  const fixture = buildFullFixture(opts);
  const context = mkCompileContext(fixture.byAddress);
  const fragments = stubFragments(fixture);
  for (const node of fixture.nodes) {
    const driver = COMPUTE_DRIVERS.find((d) => d.nativeType === node.nativeType);
    if (driver) fragments.set(node.address, driver.compile!(node, context));
  }
  return fragments;
}

describe("compiled driver expression inventory", () => {
  it("accepts every string/key and pins the functions emitted by all cloud fixture graphs", () => {
    const fixtures = [
      awsNetwork(fixtureGraph()), standardFragments(), awsCompute(),
      awsCompute({ port: null, withLb: false }),
      awsCompute({ artifact: { type: "image", ref: "ghcr.io/acme/web:1" }, withSecret: false }),
      azureCompile(sampleGraph(), (n) => AZURE_DRIVERS.find((d) => d.nativeType === n.nativeType)),
      gcpCompile(environmentNodes()).compileAll(),
      ociCompile(expandOci(webStack())).fragments,
      ociCompile(expandOci(webStack(), OCI_PROD)).fragments,
    ];
    const calls = new Set<string>();
    let expressions = 0;
    for (const fragments of fixtures) {
      const types = new Set(["terraform_data"]);
      for (const f of fragments.values()) for (const type of Object.keys(f.resource ?? {})) types.add(type);
      for (const f of fragments.values()) for (const source of strings(f)) {
        const scan = scanHclTemplate(source);
        if (!scan.pureLiteral) expressions++;
        scan.calls.forEach((call) => calls.add(call));
        expect(expressionRefusal(source, types), "compiled driver expression").toBeUndefined();
      }
    }
    expect(expressions).toBeGreaterThan(200);
    expect([...calls].sort()).toEqual(["element", "jsonencode", "length", "sort", "tolist", "trimsuffix"]);
  });
});
