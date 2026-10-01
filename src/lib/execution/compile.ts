/**
 * Graph → pinned OpenTofu workspace.
 *
 *   graph nodes ──driver.compile──▶ TofuFragment per node ──assembleWorkspace──▶ TofuWorkspace
 *
 * Which nodes compile: `managed` nodes always (their driver must exist and be
 * able to compile); `referenced` nodes when their driver offers a compile (it
 * may only read: the assembler rejects a `resource` block on a node Zenith does
 * not manage); `external` nodes never.
 *
 * `CompileContext.ref(address, attribute)` is implemented here, because drivers
 * are told never to hard-code another node's tofu label. It returns the
 * INTERPOLATION form, ready to use as a value or to embed in a longer string:
 *
 *     ctx.ref("network/main", "id")  →  "${aws_vpc.network_main.id}"
 *
 * The node's tofu address is its PRIMARY address: the entry of the fragment's
 * `addresses` whose label equals the sanitized node address (`network/main` →
 * `network_main`, per DRIVER-CONVENTIONS), else the first resource address the
 * fragment lists. Referencing a node that has not compiled yet compiles it on
 * demand (a dependency cycle is an error), so a driver may reference any node
 * of the graph, not only those it declared in `dependsOn`.
 *
 * State backend (default, AWS only): the S3 bucket and optional KMS key of the
 * connection, key `zenith/<workspace>/<environment>/terraform.tfstate`. The
 * connection holds only non-secret identifiers; credentials never enter a
 * workspace file (the assembler refuses credential-shaped keys).
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { AwsConnectionConfig, ProviderConnection } from "@/lib/credentials/types";
import type { ProviderKey, ResourceGraph } from "@/lib/resources/types";
import { assembleWorkspace, TofuWorkspaceError, type BackendConfig } from "@/lib/tofu/workspace";
import type { ProviderSetName, ProviderSetSpec } from "@/lib/tofu/providers";
import type { TofuWorkspace } from "@/lib/tofu/types";
import type { ExecContext } from "./context";
import { StepFailedError } from "./errors";
import type { DriverLookup, WorkspaceOverrides } from "./ports";
import { baseTags, namePrefix, nodeTags } from "./session";
import { errorText, safeText } from "./text";

const ATTRIBUTE = /^[A-Za-z0-9_.[\]-]+$/;

/** `service/web` → `service_web`, per DRIVER-CONVENTIONS ("labels derived from the node address"). */
export const sanitizeLabel = (address: string): string => address.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** The node's primary tofu address in a fragment (see the module comment). */
export function primaryAddress(nodeAddress: string, fragment: TofuFragment): string | undefined {
  const wanted = sanitizeLabel(nodeAddress);
  const resources = fragment.addresses.filter((a) => !a.startsWith("data."));
  const matching = (list: string[]): string | undefined => list.find((a) => a.slice(a.lastIndexOf(".") + 1) === wanted);
  return matching(resources) ?? resources[0] ?? matching(fragment.addresses) ?? fragment.addresses[0];
}

export interface CompiledGraph {
  fragments: Map<string, TofuFragment>;
}

export function compileGraph(input: { graph: ResourceGraph; environmentId: string; region: string; tags: Record<string, string>; drivers: DriverLookup }): CompiledGraph {
  const { graph, drivers } = input;
  const nodes = new Map(graph.nodes.map((n) => [n.address, n]));
  const done = new Map<string, TofuFragment | null>();
  const inFlight: string[] = [];
  const prefix = namePrefix(input.environmentId);

  const compileNode = (address: string): TofuFragment | null => {
    if (done.has(address)) return done.get(address) ?? null;
    const node = nodes.get(address);
    if (!node) throw new StepFailedError(`A driver referenced ${safeText(address, 120)}, which is not a node of this graph.`);
    if (node.ownership === "external") {
      done.set(address, null);
      return null;
    }
    const driver = drivers(node.provider, node.nativeType);
    if (!driver || typeof driver.compile !== "function") {
      if (node.ownership === "managed") {
        throw new StepFailedError(`${node.address}: ${driver ? `driver ${driver.id} cannot compile` : `no driver is registered for ${node.provider} ${node.nativeType}`}.`);
      }
      done.set(address, null); // a referenced node nobody can read contributes nothing
      return null;
    }
    if (inFlight.includes(address)) throw new StepFailedError(`Drivers reference each other in a cycle: ${[...inFlight.slice(inFlight.indexOf(address)), address].join(" → ")}.`);
    inFlight.push(address);
    const ctx: CompileContext = {
      environmentId: input.environmentId,
      namePrefix: prefix,
      region: node.region || input.region,
      tags: nodeTags(input.tags, node),
      node: (a) => nodes.get(a),
      ref: (target, attribute) => {
        if (!ATTRIBUTE.test(attribute)) throw new StepFailedError(`Driver ${driver.id} asked for an invalid attribute reference "${safeText(attribute, 60)}".`);
        const fragment = compileNode(target);
        const primary = fragment ? primaryAddress(target, fragment) : undefined;
        if (!primary) throw new StepFailedError(`${node.address} references ${safeText(target, 120)}, which has no OpenTofu address (it is external, or its driver cannot compile).`);
        return `\${${primary}.${attribute}}`;
      },
    };
    let fragment: TofuFragment;
    try {
      fragment = driver.compile(node, ctx);
    } catch (err) {
      if (err instanceof StepFailedError) throw err;
      throw new StepFailedError(`Driver ${driver.id} failed to compile ${node.address}: ${errorText(err)}`);
    } finally {
      inFlight.pop();
    }
    done.set(address, fragment);
    return fragment;
  };

  const fragments = new Map<string, TofuFragment>();
  for (const node of graph.nodes) {
    const fragment = compileNode(node.address);
    if (fragment) fragments.set(node.address, fragment);
  }
  return { fragments };
}

/* ------------------------------ workspace -------------------------------- */

const DEFAULT_PROVIDER_SETS: Partial<Record<ProviderKey, ProviderSetName>> = {
  aws: "aws",
  gcp: "gcp",
  azure: "azure",
  oci: "oci",
  kubernetes: "kubernetes",
  zenith: "kubernetes",
};

function providerSetFor(provider: ProviderKey, overrides?: WorkspaceOverrides): ProviderSetName | ProviderSetSpec {
  const chosen = overrides?.providerSet?.(provider) ?? DEFAULT_PROVIDER_SETS[provider];
  if (!chosen) throw new StepFailedError(`Environments on ${provider} are not executed through OpenTofu by this worker.`);
  return chosen;
}

function backendFor(ec: ExecContext, connection: ProviderConnection, overrides?: WorkspaceOverrides): { backend: BackendConfig; stateKey?: string } {
  if (overrides?.backend) return overrides.backend({ connection, workspaceId: ec.workspaceId, environmentId: ec.environmentId });
  const config = connection.config;
  if (config.provider !== "aws") {
    throw new StepFailedError(`No OpenTofu state backend is implemented for ${config.provider} connections; only AWS (S3 in the customer's account) is.`);
  }
  const aws: AwsConnectionConfig = config;
  if (!aws.stateBucket) throw new StepFailedError("The AWS connection has no state bucket. Run the bootstrap that creates one in the customer account, then record it on the connection.");
  return {
    backend: { kind: "s3", bucket: aws.stateBucket, region: aws.region, ...(aws.stateKmsKeyArn ? { encryptionKmsKeyArn: aws.stateKmsKeyArn } : {}) },
    stateKey: `zenith/${ec.workspaceId}/${ec.environmentId}/terraform.tfstate`,
  };
}

export function buildWorkspace(input: {
  ec: ExecContext;
  graph: ResourceGraph;
  connection: ProviderConnection;
  drivers: DriverLookup;
  overrides?: WorkspaceOverrides;
}): { ws: TofuWorkspace; fragments: Map<string, TofuFragment> } {
  const { ec, graph, connection } = input;
  const env = ec.product.environment;
  const tags = baseTags(ec);
  const { fragments } = compileGraph({ graph, environmentId: ec.environmentId, region: env.region, tags, drivers: input.drivers });
  const { backend, stateKey } = backendFor(ec, connection, input.overrides);
  const providerSet = providerSetFor(env.provider, input.overrides);
  try {
    const ws = assembleWorkspace({ graph, fragments, providerSet, region: env.region, backend, stateKey, tags });
    return { ws, fragments };
  } catch (err) {
    // Assembler refusals (duplicate addresses, forbidden constructs, credential-shaped keys) name node addresses, never values.
    if (err instanceof TofuWorkspaceError) throw new StepFailedError(`The infrastructure configuration was refused: ${safeText(err.message, 400)}`);
    throw err;
  }
}

