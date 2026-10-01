/**
 * Test support for AWS driver tests: a compile context whose `ref` follows the
 * name-based protocol of src/lib/providers/aws/drivers/shared/refs.ts, a fake
 * AwsSession that builds REAL SDK clients (so `aws-sdk-client-mock` intercepts
 * them), a DriverContext, and helpers to compile a whole graph and assemble it
 * into a tofu workspace.
 *
 * STAND-INS, not implementations: `aws:ecs_service` and `aws:rds_instance` belong
 * to the compute and data drivers (other workstreams). `compileGraph` compiles
 * those nodes with `standInFragment`, which defines only a `terraform_data`
 * placeholder plus the node's security group through the shared contract — just
 * enough to let the network drivers' cross-node references resolve and
 * `tofu validate` run over the whole fixture graph.
 */
import type { AwsClientCtor, AwsSession } from "@/lib/credentials/types";
import type { CompileContext, DriverContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import { networkDrivers } from "@/lib/providers/aws/drivers/network";
import { FragmentBuilder, addSecurityGroup, refLocalName, tfLabel } from "@/lib/providers/aws/drivers/shared";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import type { TofuWorkspace } from "@/lib/tofu/types";
import { FIXTURE_ENVIRONMENT_ID, FIXTURE_NAME_PREFIX, FIXTURE_NOW, FIXTURE_REGION, FIXTURE_TAGS, FIXTURE_WORKSPACE_ID } from "./graph";

export function compileCtx(graph: ResourceGraph, over: Partial<CompileContext> = {}): CompileContext {
  const byAddress = new Map(graph.nodes.map((n) => [n.address, n]));
  return {
    environmentId: graph.environmentId,
    namePrefix: FIXTURE_NAME_PREFIX,
    region: FIXTURE_REGION,
    tags: { ...FIXTURE_TAGS },
    ref: (address, attribute) => `\${local.${refLocalName(address, attribute)}}`,
    node: (address) => byAddress.get(address),
    ...over,
  };
}

export function fakeSession(region = FIXTURE_REGION): AwsSession {
  return {
    provider: "aws",
    accountId: "123456789012",
    region,
    expiresAt: new Date(FIXTURE_NOW.getTime() + 900_000).toISOString(),
    transport: "emulator",
    client<C>(ctor: AwsClientCtor<C>, overrides?: { region?: string }): C {
      return new ctor({ region: overrides?.region ?? region, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
    },
    childProcessEnv: () => ({}),
  };
}

export function driverCtx(over: Partial<DriverContext<AwsSession>> = {}): DriverContext<AwsSession> {
  return {
    provider: "aws",
    region: FIXTURE_REGION,
    workspaceId: FIXTURE_WORKSPACE_ID,
    environmentId: FIXTURE_ENVIRONMENT_ID,
    session: fakeSession(),
    signal: new AbortController().signal,
    log: () => undefined,
    tags: { ...FIXTURE_TAGS },
    now: () => FIXTURE_NOW,
    ...over,
  };
}

/** Placeholder fragment for nodes whose drivers live in other workstreams. */
export function standInFragment(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const b = new FragmentBuilder(node.address);
  b.resource("terraform_data", tfLabel(node.address), { input: node.address });
  addSecurityGroup(b, node, ctx);
  return b.build();
}

export function driverFor(node: ResourceNode): ResourceDriver<AwsSession> | undefined {
  return networkDrivers.find((d) => d.nativeType === node.nativeType);
}

/** Compile every node of the graph: network drivers for theirs, stand-ins for compute/data. */
export function compileGraph(graph: ResourceGraph, ctxOver: Partial<CompileContext> = {}): Map<string, TofuFragment> {
  const ctx = compileCtx(graph, ctxOver);
  const out = new Map<string, TofuFragment>();
  for (const node of [...graph.nodes].sort((a, b) => (a.address < b.address ? -1 : 1))) {
    const driver = driverFor(node);
    out.set(node.address, driver?.compile ? driver.compile(node, ctx) : standInFragment(node, ctx));
  }
  return out;
}

export function assemble(graph: ResourceGraph, fragments: Map<string, TofuFragment>): TofuWorkspace {
  return assembleWorkspace({
    graph,
    fragments,
    providerSet: "aws",
    region: FIXTURE_REGION,
    backend: { kind: "local", path: "terraform.tfstate" },
    tags: { ...FIXTURE_TAGS },
  });
}

/** `main.tf.json` of a workspace, parsed. */
export function mainOf(ws: TofuWorkspace): { resource?: Record<string, Record<string, Record<string, unknown>>>; data?: Record<string, Record<string, Record<string, unknown>>>; locals?: Record<string, unknown>; output?: Record<string, unknown> } {
  const f = ws.files.find((x) => x.path === "main.tf.json");
  if (!f) throw new Error("workspace has no main.tf.json");
  return JSON.parse(f.content);
}
