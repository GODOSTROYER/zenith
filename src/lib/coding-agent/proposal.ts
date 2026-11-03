import { proposeArchitecture, type AppRequirements, type ProposalIntent } from "@/lib/analysis";
import { digest } from "@/lib/controlplane/digest";
import type { AnyManifest, Manifest, Service } from "@/lib/domain/types";
import { parseManifest } from "@/lib/resources/manifest-v2";
import { upgradeManifest } from "@/lib/resources/upgrade";
import type { AgentSourceRef, ProposalArtifact } from "./types";
import { redactSourceValue } from "./redaction";

/** Add source-derived nodes while retaining existing infrastructure and all V2-only policy/placement fields. */
export function preserveProjectManifest(proposed: Manifest, base?: AnyManifest): AnyManifest {
  if (!base) return upgradeManifest(proposed, { provider: "auto" });
  const manifest = structuredClone(base);
  const remap = new Map<string, string>();
  for (const service of proposed.services) {
    const existing = manifest.services.find(s => s.name === service.name);
    if (existing) {
      remap.set(service.id, existing.id);
      // Preserve operator sizing, environment, ownership and stable node IDs.
      existing.source = service.source;
      if (service.port !== undefined) existing.port = service.port;
      if (service.healthPath !== undefined) existing.healthPath = service.healthPath;
      const names = new Set(existing.env.map(e => e.key));
      existing.env.push(...service.env.filter(e => !names.has(e.key)));
    } else manifest.services.push(service);
  }
  for (const resource of proposed.resources) {
    const existing = manifest.resources.find(r => r.name === resource.name && r.kind === resource.kind);
    if (existing) remap.set(resource.id, existing.id);
    else manifest.resources.push(resource);
  }
  for (const route of proposed.routes) {
    if (!manifest.routes.some(r => r.id === route.id)) manifest.routes.push(route);
  }
  for (const binding of proposed.bindings) {
    const next = { ...binding, from: remap.get(binding.from) ?? binding.from, to: remap.get(binding.to) ?? binding.to };
    if (!manifest.bindings.some(b => b.id === next.id || (b.from === next.from && b.to === next.to && b.capability === next.capability))) manifest.bindings.push(next);
  }
  const parsed = parseManifest(manifest);
  if (!parsed.ok) throw new Error("The proposal conflicts with existing infrastructure. Review the requirements before adopting.");
  return parsed.manifest;
}

export function buildProposalArtifact(requirements: AppRequirements, intent: ProposalIntent, source?: AgentSourceRef, base?: AnyManifest): ProposalArtifact {
  const proposal = proposeArchitecture(requirements, intent);
  if (source) {
    for (const service of proposal.manifest.services) {
      if (service.source.type !== "git") continue;
      const git: Extract<Service["source"], { type: "git" }> = service.source;
      git.repo = "https://github.com/" + source.repository;
      git.ref = source.commit;
      // A context proof applies only to its exact Dockerfile. Other candidates keep full-repository build context.
      if (source.contextDigest && source.dockerfile === git.dockerfile) {
        git.contextDir = source.contextDir ?? "";
        git.contextDigest = source.contextDigest;
      }
    }
  }
  const manifest = preserveProjectManifest(proposal.manifest, base);
  return {
    manifest, manifestDigest: digest(manifest), requirementsDigest: digest(requirements),
    explanations: redactSourceValue([...proposal.explanations, ...(base ? ["Existing infrastructure, sizing, environment references and V2 settings are retained. Source-derived additions and updates require review."] : [])].slice(0, 40)),
    unresolved: redactSourceValue(proposal.unresolved.slice(0, 40)),
    confidence: proposal.confidence, environmentClass: intent.environmentClass,
  };
}
