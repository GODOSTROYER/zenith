/**
 * Desired state for one operation: product-store manifest → (V1 → V2 upgrade)
 * → `parseManifest` → `expandManifest` → `ResourceGraph`, plus the problems that
 * make a graph NOT executable by this worker.
 *
 * Nothing here persists anything: a V1 manifest is upgraded in memory with the
 * environment's provider and region (and its V1 policies) and the V2 result is
 * used only to expand. The revision in the product store stays V1.
 *
 * `findGraphProblems` is the gate `validateDesiredState` reports and the
 * workflow fails fast on. It is deliberately about EXECUTABILITY, not about
 * quality of the design (that is policy's and the cost engine's job):
 *
 *   - a node with no native mapping on its provider (`unsupported:…`)
 *   - a MANAGED node with no registered driver, or whose driver cannot compile
 *   - a REFERENCED data node (database, cache, bucket, queue, …) with no
 *     `externalRef`: Zenith cannot locate what it was told to reference.
 *     (Referenced services and DNS zones are exempt: the V1 model gives a
 *     service no external reference, and a zone is found by name.)
 *   - a node placed on a provider other than the environment's: refused unless the
 *     caller holds a `MixedAdmission` (mixed/admission.ts), minted only when every
 *     partition of a stored parent plan has a bound, verified connection
 *   - a managed service built from a `blueprint` source (only the sandbox
 *     provider can run those)
 *
 * `external` nodes are documentation and never a problem.
 *
 * Zenith-managed environments (PROD-MAN-01) are judged by the managed provider's own classification
 * (`assessZenithGraph`): nodes the platform provides itself (network, DNS, TLS) or does not offer but that do not
 * block a deploy (log group, registry, build pipeline) are not executable resources and are never a problem; kinds the
 * managed platform cannot honor are problems naming why; everything else must have a registered driver, and is
 * realized by render + server-side apply like Kubernetes, not by compiling OpenTofu.
 */
import { expandManifest, ManifestExpansionError } from "@/lib/resources/expand";
import { isV1, parseManifest, type ManifestV2 } from "@/lib/resources/manifest-v2";
import { isUnsupportedNativeType } from "@/lib/resources/native-types";
import type { ResourceGraph } from "@/lib/resources/types";
import { STATEFUL_KINDS } from "@/lib/resources/types";
import { upgradeManifest } from "@/lib/resources/upgrade";
import { RENDERABLE_KINDS } from "@/lib/providers/kubernetes/render";
import { assessZenithGraph } from "@/lib/providers/zenith/render";
import type { ArtifactSpec } from "@/lib/resources/specs";
import type { DriverLookup, ProductContext } from "./ports";
import { isMixedAdmission, type MixedAdmission } from "./mixed/admission";
import { errorText, safeText } from "./text";

export interface DesiredState {
  manifest?: ManifestV2;
  graph?: ResourceGraph;
  /** manifest / expansion problems: no graph exists */
  problems: string[];
  /** upgrade defaults applied, one line each */
  notes: string[];
}

export function buildDesiredState(product: ProductContext): DesiredState {
  const { environment, revision } = product;
  if (!revision) {
    return { problems: ["There is no revision to execute: the operation names none and the environment has nothing deployed."], notes: [] };
  }
  const parsed = parseManifest(revision.manifest);
  if (!parsed.ok) {
    return { problems: parsed.errors.slice(0, 20).map((e) => safeText(`manifest ${e.path ? `${e.path}: ` : ""}${e.message}`, 300)), notes: [] };
  }
  let manifest: ManifestV2;
  const notes: string[] = [];
  try {
    if (isV1(parsed.manifest)) {
      manifest = upgradeManifest(parsed.manifest, { provider: environment.provider, region: environment.region, policies: environment.policies });
      notes.push(`Revision ${revision.number} is a V1 manifest: upgraded in memory to V2 for ${environment.provider}/${environment.region}; the stored revision is unchanged.`);
    } else {
      manifest = parsed.manifest;
    }
  } catch (err) {
    return { problems: [safeText(`cannot upgrade the V1 manifest for ${environment.provider}/${environment.region}: ${errorText(err)}`, 300)], notes };
  }
  try {
    const graph = expandManifest(manifest, {
      id: environment.id,
      name: environment.name,
      class: environment.class,
      provider: environment.provider,
      region: environment.region,
      baseDomain: environment.baseDomain,
    });
    return { manifest, graph, problems: [], notes };
  } catch (err) {
    if (err instanceof ManifestExpansionError) return { manifest, problems: [safeText(`the manifest cannot be expanded: ${err.message}`, 300)], notes };
    throw err;
  }
}

const isStateful = (kind: string): boolean => (STATEFUL_KINDS as readonly string[]).includes(kind);

type ZenithClass = { kind: "platform" | "not_offered" | "unsupported" | "database" | "render"; reason: string };

function zenithClasses(graph: ResourceGraph): Map<string, ZenithClass> {
  const assessed = assessZenithGraph(graph.nodes);
  const out = new Map<string, ZenithClass>();
  for (const n of assessed.render) out.set(n.address, { kind: "render", reason: "" });
  for (const n of assessed.databases) out.set(n.address, { kind: "database", reason: "" });
  for (const n of assessed.platformManaged) out.set(n.address, { kind: "platform", reason: n.reason });
  for (const n of assessed.notOffered) out.set(n.address, { kind: "not_offered", reason: n.reason });
  for (const n of assessed.unsupported) out.set(n.address, { kind: "unsupported", reason: n.reason });
  return out;
}

export function findGraphProblems(graph: ResourceGraph, environmentProvider: string, drivers: DriverLookup, admission?: MixedAdmission): string[] {
  const problems: string[] = [];
  const managedClass = environmentProvider === "zenith" ? zenithClasses(graph) : undefined;
  for (const node of graph.nodes) {
    if (node.ownership === "external") continue;
    const zenithClass = node.provider === "zenith" ? managedClass?.get(node.address) : undefined;
    if (zenithClass && (zenithClass.kind === "platform" || zenithClass.kind === "not_offered")) continue;
    if (zenithClass?.kind === "unsupported") {
      problems.push(`${node.address}: the managed platform cannot realize a ${node.kind} (${zenithClass.reason}).`);
      continue;
    }

    // Kubernetes has no log group object: logs are the pods' own, read through container.logs. The derived
    // node is not an unexecutable resource there, it is simply realized by the workload.
    if (environmentProvider === "kubernetes" && node.kind === "log_group" && isUnsupportedNativeType(node.nativeType)) continue;
    if (isUnsupportedNativeType(node.nativeType)) {
      problems.push(`${node.address}: a ${node.kind} has no native realization on ${node.provider} (${node.nativeType}); it cannot be executed there.`);
      continue;
    }
    // A foreign placement is explained only by an admission minted for this very address; anything else keeps the refusal.
    const admitted = admission !== undefined && isMixedAdmission(admission) && admission.addresses.has(node.address);
    if (node.provider !== environmentProvider && !admitted) {
      problems.push(`${node.address} is placed on ${node.provider}/${node.region} but this environment executes on ${environmentProvider}; multi-provider graphs are not executable yet.`);
      continue;
    }
    if (node.ownership === "referenced" && isStateful(node.kind) && !node.externalRef) {
      problems.push(`${node.address} is referenced but has no externalRef, so Zenith cannot locate it.`);
    }
    if (node.ownership === "managed") {
      const driver = drivers(node.provider, node.nativeType);
      if (!driver) problems.push(`${node.address}: no driver is registered for ${node.provider} ${node.nativeType}.`);
      else if (environmentProvider === "kubernetes" || environmentProvider === "zenith") {
        // Kubernetes realizes nodes by render + server-side apply, not by compiling OpenTofu: what matters is that it can render the kind.
        // (A managed Zenith database is realized by the managed-database port, which the assessment already classified.)
        if (zenithClass?.kind !== "database" && !RENDERABLE_KINDS.includes(node.kind)) problems.push(`${node.address}: a ${node.kind} cannot be rendered on ${environmentProvider === "zenith" ? "the managed platform" : "Kubernetes"}.`);
      } else if (typeof driver.compile !== "function") problems.push(`${node.address}: driver ${driver.id} cannot compile (it is observe-only), so it cannot manage this node.`);
      const artifact = node.spec.artifact as ArtifactSpec | undefined;
      if (artifact?.type === "blueprint" && node.provider !== "sandbox") {
        problems.push(`${node.address} uses blueprint source "${artifact.blueprint}", which only the sandbox provider can run; ${node.provider} needs an image or git source.`);
      }
    }
  }
  return problems.map((p) => safeText(p, 400));
}
