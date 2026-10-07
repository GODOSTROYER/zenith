/** The execution compiler refuses identifiers that cannot fit IAM/S3 before any driver runs. Pure; no cloud, no OpenTofu. */
import { describe, expect, it } from "vitest";
import type { ResourceDriver } from "@/lib/drivers/types";
import { compileGraph } from "@/lib/execution/compile";
import { StepFailedError } from "@/lib/execution/errors";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { providerConnection } from "./fakes/fixtures";

const node: ResourceNode = { address: "network/main", provider: "aws", nativeType: "network/main", kind: "provider_native", ownership: "managed", region: "us-east-1", spec: {}, specDigest: "0".repeat(64), origin: [], dependsOn: [], labels: {} };
const driver = (calls: string[]): ResourceDriver => ({
  id: "test.network", provider: "aws", nativeType: "network/main", kind: "provider_native",
  capabilities: { compile: true, observe: false, runtime: false, verify: false, discover: false, operations: [], evidence: { compile: "simulated" } },
  compile: () => { calls.push("compile"); return { addresses: ["aws_vpc.network_main"] }; },
});
const graph = (environmentId: string): ResourceGraph => ({ version: 1, environmentId, manifestDigest: "m", graphDigest: "g", notes: [], edges: [], nodes: [node] });
const run = (environmentId: string, suffix?: string) => {
  const calls: string[] = [];
  const connection = providerConnection();
  if (connection.config.provider === "aws" && suffix !== undefined) connection.config = { ...connection.config, bootstrapNameSuffix: suffix };
  const d = driver(calls);
  const compiled = () => compileGraph({ graph: graph(environmentId), environmentId, region: "us-east-1", tags: {}, drivers: () => d, connection });
  return { compiled, calls };
};

describe("AWS identifier limits at compile time", () => {
  it("compiles the maximum environment id with the maximum suffix", () => {
    const { compiled, calls } = run("e".repeat(64), `-${"a".repeat(19)}`);
    expect(() => compiled()).not.toThrow();
    expect(calls).toEqual(["compile"]);
  });

  it.each(["e".repeat(65), "env/1", "env 1", "env*"])("refuses environment id %j before any driver compiles", (environmentId) => {
    const { compiled, calls } = run(environmentId);
    expect(compiled).toThrow(StepFailedError);
    expect(compiled).toThrow(/environment id is not a valid AWS name component/);
    expect(calls).toEqual([]);
  });

  it("refuses a malformed saved suffix before any driver compiles", () => {
    const { compiled, calls } = run("env-1", "-Bad Suffix");
    expect(compiled).toThrow();
    expect(calls).toEqual([]);
  });
});
