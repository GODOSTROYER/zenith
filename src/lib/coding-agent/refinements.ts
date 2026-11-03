import { z } from "zod";
import type { AppRequirements, Evidence, RepoSnapshot } from "@/lib/analysis/types";
import { normalizeInspectionRoot } from "@/lib/sources/github/inspect";
import { redactSourceText } from "./redaction";

const EvidenceRef = z.object({ path: z.string().min(1).max(240), line: z.number().int().positive() }).strict();
const Proof = { evidence: z.array(EvidenceRef).min(1).max(5), reason: z.string().min(1).max(400) };
export const RefinementArgs = z.object({
  services: z.array(z.object({
    root: z.string().max(200), name: z.string().min(1).max(60),
    port: z.number().int().min(1).max(65535).optional(),
    healthPath: z.string().regex(/^\/[A-Za-z0-9/_-]*$/).max(200).optional(),
    startCommand: z.string().min(1).max(300).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
    ...Proof,
  }).strict()).max(20).default([]),
  datastores: z.array(z.object({
    root: z.string().max(200),
    kind: z.enum(["postgres", "redis", "object_store", "queue", "email", "mysql", "mongodb", "rabbitmq", "kafka", "sqlite"]),
    role: z.enum(["publish", "consume", "both"]).optional(), ...Proof,
  }).strict()).max(20).default([]),
  questions: z.array(z.string().min(1).max(400)).max(20).default([]),
}).strict();

/** Keep global/shared dependency findings, but propose only the selected application's services. */
export function requirementsForRoot(requirements: AppRequirements, root = ""): AppRequirements {
  if (!root) return structuredClone(requirements);
  const selected = (r: string): boolean => r === root || r.startsWith(root + "/");
  const shared = (r: string): boolean => selected(r) || r === "" || root.startsWith(r + "/");
  return {
    ...structuredClone(requirements),
    services: requirements.services.filter(s => selected(s.value.root)),
    builds: requirements.builds.filter(s => selected(s.value.root)),
    runtimes: requirements.runtimes.filter(s => shared(s.value.root)),
    frameworks: requirements.frameworks.filter(s => shared(s.value.root)),
    datastores: requirements.datastores.filter(s => shared(s.value.root)),
    migrations: requirements.migrations.filter(s => shared(s.value.root)),
    healthEndpoints: requirements.healthEndpoints.filter(s => selected(s.value.root)),
    envVars: requirements.envVars.filter(s => s.value.roots.some(shared)),
  };
}

/** Model findings amend requirements only. Evidence is checked, and every claim remains medium-confidence inference. */
export function refineRequirements(current: AppRequirements, snapshot: RepoSnapshot, input: z.infer<typeof RefinementArgs>): AppRequirements {
  const result = structuredClone(current);
  const files = new Map(snapshot.files.map(f => [f.path, f.content]));
  const roots = new Set([...current.builds.map(b => b.value.root), ...current.services.map(s => s.value.root)]);
  const proof = (refs: z.infer<typeof EvidenceRef>[], rule: string): Evidence[] => refs.map(ref => {
    const text = files.get(ref.path);
    if (text === undefined || ref.line > text.split("\n").length) throw new Error("Evidence must name a line in the exact snapshot.");
    return { ...ref, rule };
  });
  for (const item of input.services) {
    const root = normalizeInspectionRoot(item.root);
    const service = result.services.find(s => s.value.root === root && s.value.name === item.name);
    if (!service) throw new Error("Refinement must identify a detected service.");
    const evidence = proof(item.evidence, "model:service-refinement");
    if (item.port !== undefined) service.value.port = { value: item.port, evidence, confidence: "medium" };
    if (item.healthPath !== undefined) service.value.healthPath = { value: item.healthPath, evidence, confidence: "medium" };
    if (item.startCommand !== undefined) service.value.startCommand = { value: redactSourceText(item.startCommand), evidence, confidence: "medium" };
    service.value.note = "Model inference, review required: " + redactSourceText(item.reason);
    service.confidence = "medium";
    service.evidence = [...service.evidence, ...evidence].slice(0, 12);
  }
  for (const item of input.datastores) {
    const root = normalizeInspectionRoot(item.root);
    if (!roots.has(root)) throw new Error("Datastore must belong to a detected application.");
    const evidence = proof(item.evidence, "model:datastore-refinement");
    if (result.datastores.some(d => d.value.root === root && d.value.kind === item.kind)) continue;
    result.datastores.push({
      value: { root, kind: item.kind, supportedInV1: ["postgres", "redis", "object_store", "queue", "email"].includes(item.kind),
        ...(item.role ? { role: item.role } : {}), note: "Model inference, review required: " + redactSourceText(item.reason) },
      confidence: "medium", evidence,
    });
  }
  result.unknowns = [...new Set([...result.unknowns, ...input.questions.map(redactSourceText)])].slice(0, 100);
  return result;
}
