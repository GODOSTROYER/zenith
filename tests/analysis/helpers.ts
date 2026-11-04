import { analyzeRepository, snapshotFromFiles, type AppRequirements, type Inference, type RepoSnapshot, type ServiceCandidate } from "@/lib/analysis";

export const analyzeFiles = (files: Record<string, string>, source: RepoSnapshot["source"] = { kind: "fixture" }): { snapshot: RepoSnapshot; req: AppRequirements } => {
  const snapshot = snapshotFromFiles(files, { source });
  return { snapshot, req: analyzeRepository(snapshot) };
};

export const service = (req: AppRequirements, name: string): ServiceCandidate => {
  const s = req.services.find((x) => x.value.name === name);
  if (!s) throw new Error(`no service ${name}; have ${req.services.map((x) => x.value.name).join(", ")}`);
  return s.value;
};

export const serviceInference = (req: AppRequirements, name: string): Inference<ServiceCandidate> => {
  const s = req.services.find((x) => x.value.name === name);
  if (!s) throw new Error(`no service ${name}`);
  return s;
};

export const datastoreKinds = (req: AppRequirements, root?: string): string[] =>
  [...new Set(req.datastores.filter((d) => root === undefined || d.value.root === root).map((d) => d.value.kind))].sort();

export const env = (req: AppRequirements, name: string) => req.envVars.find((e) => e.value.name === name)?.value;

/** Every string anywhere in a JSON-able value (keys included). */
export function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allStrings(v, out);
    }
  }
  return out;
}

/** Every `{ value, confidence, evidence }` triple in a requirements object, wherever it is nested. */
export function inferences(value: unknown, out: { path: string; inference: Inference<unknown> }[] = [], path = "$"): { path: string; inference: Inference<unknown> }[] {
  if (Array.isArray(value)) value.forEach((v, i) => inferences(v, out, `${path}[${i}]`));
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if ("confidence" in o && "evidence" in o && "value" in o) out.push({ path, inference: o as unknown as Inference<unknown> });
    for (const [k, v] of Object.entries(o)) inferences(v, out, `${path}.${k}`);
  }
  return out;
}
