import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TofuFragment } from "@/lib/drivers/types";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { resolveTofuBinary } from "@/lib/tofu/binary";
import { assembleWorkspace, type AssembleWorkspaceInput } from "@/lib/tofu/workspace";
import type { TofuWorkspace } from "@/lib/tofu/types";

export function node(address: string, over: Partial<ResourceNode> = {}): ResourceNode {
  return {
    address,
    kind: "provider_native",
    provider: "aws",
    region: "ap-south-1",
    nativeType: "aws:test",
    ownership: "managed",
    spec: {},
    origin: [],
    dependsOn: [],
    specDigest: "0".repeat(64),
    labels: {},
    ...over,
  };
}

export function graphOf(nodes: ResourceNode[]): ResourceGraph {
  return { version: 1, environmentId: "env_1", manifestDigest: "m".repeat(8), nodes, edges: [], graphDigest: "g".repeat(8), notes: [] };
}

/** A fragment defining `terraform_data.<name>` with the given input. */
export function dataFragment(name: string, input: unknown, extra: Partial<TofuFragment> = {}): TofuFragment {
  return {
    resource: { terraform_data: { [name]: { input } } },
    addresses: [`terraform_data.${name}`],
    ...extra,
  };
}

let tofuBin: string | undefined;
export function tofuOnPath(): boolean {
  try {
    tofuBin ??= resolveTofuBinary();
    return spawnSync(tofuBin, ["version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export function tempDir(prefix = "zenith-tofu-test-"): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) };
}

export interface BuiltWorkspace {
  ws: TofuWorkspace;
}

/** A builtin-provider workspace with a local backend at `statePath`. */
export function builtinWorkspace(statePath: string, fragments: Record<string, TofuFragment>, over: Partial<AssembleWorkspaceInput> = {}): TofuWorkspace {
  const graph = graphOf(Object.keys(fragments).map((a) => node(a)));
  return assembleWorkspace({
    graph,
    fragments: new Map(Object.entries(fragments)),
    providerSet: "builtin",
    region: "ap-south-1",
    backend: { kind: "local", path: statePath },
    tags: {},
    ...over,
  });
}
