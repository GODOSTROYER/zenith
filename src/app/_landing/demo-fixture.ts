import { Manifest } from "@/lib/domain/types";
import { monthlyCostUsd } from "@/lib/cost/pricing";

/** Public, synthetic fixtures. Never read an account or call a provider. */
export const CURRENT_DEMO_MANIFEST = Manifest.parse({
  version: 1,
  services: [
    { id: "atlas-api", name: "atlas-api", kind: "web", source: { type: "image", image: "example.invalid/atlas-api:demo" }, size: "small", replicas: 1, port: 8080, env: [], ownership: "managed" },
    { id: "atlas-worker", name: "atlas-worker", kind: "worker", source: { type: "image", image: "example.invalid/atlas-worker:demo" }, size: "small", replicas: 1, env: [], ownership: "managed" },
  ],
  resources: [], routes: [], bindings: [],
});

export const PROPOSED_DEMO_MANIFEST = Manifest.parse({
  ...CURRENT_DEMO_MANIFEST,
  resources: [{ id: "atlas-jobs", name: "atlas-jobs", kind: "queue", size: "nano", config: {}, ownership: "managed" }],
  bindings: [
    { id: "api-publishes-jobs", from: "atlas-api", to: "atlas-jobs", capability: "queue_publish", note: "API publishes background jobs." },
    { id: "worker-consumes-jobs", from: "atlas-worker", to: "atlas-jobs", capability: "queue_consume", note: "Worker consumes background jobs." },
  ],
});

export const DEMO_COST = {
  current: monthlyCostUsd(CURRENT_DEMO_MANIFEST),
  proposed: monthlyCostUsd(PROPOSED_DEMO_MANIFEST),
  delta: monthlyCostUsd(PROPOSED_DEMO_MANIFEST) - monthlyCostUsd(CURRENT_DEMO_MANIFEST),
};
export const DEMO_STEPS = ["Prepare the queue fixture", "Connect publish and consume bindings", "Record the simulated revision"] as const;
export type DemoSelection = "atlas-api" | "atlas-worker" | "atlas-jobs";
export const revisionLabel = (revision: number) => String(revision).padStart(2, "0");

export function demoSource(manifest: Manifest, revision: number): string {
  return `// SYNTHETIC · atlas · revision ${revisionLabel(revision)}\n// Canonical manifest · illustrative image references\n${JSON.stringify(manifest, null, 2)}`;
}

/** This matches the existing typed action endpoint; it is displayed, never sent. */
export function demoApi(manifest: Manifest, revision: number): string {
  return `// SYNTHETIC · revision ${revisionLabel(revision)}\n// Request example only. No request is sent.\nPOST /api/actions/project.updateManifest\nContent-Type: application/json\n\n${JSON.stringify({ mode: "plan", scope: { projectId: "sim-atlas" }, input: { projectId: "sim-atlas", manifest } }, null, 2)}`;
}
