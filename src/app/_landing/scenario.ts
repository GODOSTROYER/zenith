/**
 * The one example system every chapter reads: an application that accepts
 * uploads, processes them in the background and returns results.
 *
 * Public, synthetic fixtures. They never read an account or call a provider.
 * The manifests are real product manifests; the estimates come from the
 * product's own static estimate tables; the plan comes from the product's own
 * diff. The traffic-to-configuration sizing rules further down are the one
 * thing Zenith does not compute today, and every surface labels them so.
 */
import { Manifest, type BindingCapability, type Changeset, type ServiceSize } from "@/lib/domain/types";
import { monthlyCostUsd, nodeMonthlyCostUsd } from "@/lib/cost/pricing";
import type { FlowStep } from "./landing-motion";
import { diffManifests } from "@/lib/domain/graph";

export type ExampleNodeId = "public-route" | "upload-api" | "uploads" | "process-jobs" | "process-worker" | "results";
export const EXAMPLE_NODE_IDS: ExampleNodeId[] = ["public-route", "upload-api", "process-jobs", "process-worker", "uploads", "results"];

export interface NodeMeta {
  id: ExampleNodeId;
  /** plain-language name, the first thing anyone reads */
  label: string;
  /** one sentence: what it does for the application */
  role: string;
  /** the technical sentence behind the disclosure */
  detail: string;
  /** desktop layout: four columns, two rows */
  grid: { col: number; row: number };
  /** reading order when the diagram stacks */
  stack: number;
}

export const NODE_META: Record<ExampleNodeId, NodeMeta> = {
  "public-route": { id: "public-route", label: "Public address", role: "Where requests arrive.", detail: "A hostname with managed TLS. Zenith routes it to the upload API and nothing else.", grid: { col: 0, row: 0 }, stack: 0 },
  "upload-api": { id: "upload-api", label: "Upload API", role: "Accepts uploads and answers requests.", detail: "A web service. In the current system it also does the processing itself, so a slow file makes a slow response.", grid: { col: 1, row: 0 }, stack: 1 },
  "process-jobs": { id: "process-jobs", label: "Processing queue", role: "Holds work until a worker is free.", detail: "A message queue. Uploads arrive at their own pace; processing happens at the workers’ pace.", grid: { col: 2, row: 0 }, stack: 2 },
  "process-worker": { id: "process-worker", label: "Processing worker", role: "Does the heavy work in the background.", detail: "A background worker with no public address. Add replicas when the queue grows.", grid: { col: 3, row: 0 }, stack: 3 },
  uploads: { id: "uploads", label: "File storage", role: "Keeps the uploaded files.", detail: "Object storage. The API writes each upload here; the worker reads it back.", grid: { col: 1, row: 1 }, stack: 4 },
  results: { id: "results", label: "Results database", role: "Stores what each job produced.", detail: "A PostgreSQL database. The API records jobs and reads results; the worker writes them.", grid: { col: 2, row: 1 }, stack: 5 },
};

export const KIND_LABEL: Record<string, string> = {
  web: "Web service", worker: "Background worker", cron: "Scheduled job", static: "Static site",
  postgres: "PostgreSQL database", redis: "Redis cache", object_store: "Object storage", queue: "Message queue", email: "Email sender",
  route: "Entry point",
};

/** The binding capability, said the way a person would say it. */
export const CAPABILITY_PHRASE: Record<BindingCapability, string> = {
  http: "sends requests to",
  blob: "stores files in",
  sql: "reads and writes",
  queue_publish: "publishes jobs to",
  queue_consume: "takes jobs from",
  cache: "caches in",
  smtp: "sends email through",
};

const IMAGE = (name: string) => ({ type: "image" as const, image: `example.invalid/${name}:demo` });

/** Today: the API accepts an upload and processes it before answering. */
export const CURRENT_SYSTEM = Manifest.parse({
  version: 1,
  services: [
    { id: "upload-api", name: "upload-api", kind: "web", source: IMAGE("upload-api"), size: "small", replicas: 1, port: 8080, env: [], ownership: "managed" },
  ],
  resources: [
    { id: "uploads", name: "uploads", kind: "object_store", size: "small", config: {}, ownership: "managed" },
    { id: "results", name: "results", kind: "postgres", size: "small", config: {}, ownership: "managed" },
  ],
  routes: [{ id: "public-route", host: "app.example.com", pathPrefix: "/", tls: true, managedDns: true }],
  bindings: [
    { id: "route-api", from: "public-route", to: "upload-api", capability: "http", note: "Requests from the public address reach the upload API." },
    { id: "api-uploads", from: "upload-api", to: "uploads", capability: "blob", note: "The API stores each uploaded file." },
    { id: "api-results", from: "upload-api", to: "results", capability: "sql", note: "The API records jobs and reads their results." },
  ],
});

/** The proposed change: a queue and a worker take the processing off the request path. */
export const PROPOSED_SYSTEM = Manifest.parse({
  ...CURRENT_SYSTEM,
  services: [
    ...CURRENT_SYSTEM.services,
    { id: "process-worker", name: "process-worker", kind: "worker", source: IMAGE("process-worker"), size: "small", replicas: 1, env: [], ownership: "managed" },
  ],
  resources: [
    ...CURRENT_SYSTEM.resources,
    { id: "process-jobs", name: "process-jobs", kind: "queue", size: "nano", config: {}, ownership: "managed" },
  ],
  bindings: [
    ...CURRENT_SYSTEM.bindings,
    { id: "api-jobs", from: "upload-api", to: "process-jobs", capability: "queue_publish", note: "The API queues one processing job per upload and answers right away." },
    { id: "worker-jobs", from: "process-worker", to: "process-jobs", capability: "queue_consume", note: "The worker takes the next job from the queue." },
    { id: "worker-uploads", from: "process-worker", to: "uploads", capability: "blob", note: "The worker reads the file it is processing." },
    { id: "worker-results", from: "process-worker", to: "results", capability: "sql", note: "The worker writes the result." },
  ],
});

/** Ids that exist only in the proposal; the diagram marks them as proposed. */
export const PROPOSED_IDS: ExampleNodeId[] = ["process-jobs", "process-worker"];
export const PROPOSED_BINDING_IDS = PROPOSED_SYSTEM.bindings.filter((b) => !CURRENT_SYSTEM.bindings.some((c) => c.id === b.id)).map((b) => b.id);

/** The product's own changeset: explanations, risk and cost deltas per item. */
export const PROPOSED_CHANGE: Changeset = diffManifests(CURRENT_SYSTEM, PROPOSED_SYSTEM);

export const ESTIMATE = {
  current: monthlyCostUsd(CURRENT_SYSTEM),
  proposed: monthlyCostUsd(PROPOSED_SYSTEM),
  delta: PROPOSED_CHANGE.totalCostDeltaUsd,
};

export const nodeCost = (manifest: Manifest, id: ExampleNodeId) => nodeMonthlyCostUsd(manifest, id);

export function systemFor(view: "current" | "proposed"): Manifest {
  return view === "proposed" ? PROPOSED_SYSTEM : CURRENT_SYSTEM;
}

/* ------------------------------ growth scenarios ------------------------------ */

interface Sizing {
  api: { size: ServiceSize; replicas: number };
  worker: { size: ServiceSize; replicas: number };
  queue: ServiceSize;
  store: ServiceSize;
  db: ServiceSize;
}

function sized(sizing: Sizing): Manifest {
  return Manifest.parse({
    ...PROPOSED_SYSTEM,
    services: PROPOSED_SYSTEM.services.map((s) => s.id === "upload-api" ? { ...s, ...sizing.api } : { ...s, ...sizing.worker }),
    resources: PROPOSED_SYSTEM.resources.map((r) => ({ ...r, size: r.id === "process-jobs" ? sizing.queue : r.id === "uploads" ? sizing.store : sizing.db })),
  });
}

export interface ScaleStep {
  id: string;
  /** the visitor-facing assumption */
  uploadsPerDay: string;
  /** what the sizing rules changed at this step */
  change: string;
  manifest: Manifest;
  estimate: number;
}

/**
 * Illustrative sizing rules, priced with the product's estimate tables.
 * Zenith does not forecast traffic today: the rules that turn uploads into
 * replica counts and sizes are assumptions written for this page, and the
 * Growth chapter says so next to every number.
 */
const SIZINGS: { id: string; uploadsPerDay: string; change: string; sizing: Sizing }[] = [
  { id: "1k", uploadsPerDay: "1,000", change: "One API replica, one worker, a nano queue: the proposal as reviewed.", sizing: { api: { size: "small", replicas: 1 }, worker: { size: "small", replicas: 1 }, queue: "nano", store: "small", db: "small" } },
  { id: "10k", uploadsPerDay: "10,000", change: "Two API replicas, three workers, file storage up a tier.", sizing: { api: { size: "small", replicas: 2 }, worker: { size: "small", replicas: 3 }, queue: "small", store: "standard", db: "small" } },
  { id: "100k", uploadsPerDay: "100,000", change: "Standard replicas on both sides, six workers, a standard database.", sizing: { api: { size: "standard", replicas: 3 }, worker: { size: "standard", replicas: 6 }, queue: "standard", store: "standard", db: "standard" } },
  { id: "1m", uploadsPerDay: "1,000,000", change: "Ten performance workers: this example’s ceiling. Past it, you review the design.", sizing: { api: { size: "performance", replicas: 4 }, worker: { size: "performance", replicas: 10 }, queue: "performance", store: "performance", db: "performance" } },
];

export const SCALE_STEPS: ScaleStep[] = SIZINGS.map(({ sizing, ...rest }) => {
  const manifest = sized(sizing);
  return { ...rest, manifest, estimate: monthlyCostUsd(manifest) };
});

export const SCALE_ASSUMPTIONS = [
  "One upload is about 5 MB and takes about 20 seconds of worker time.",
  "A small API replica handles roughly 50 requests a second; each size step roughly doubles that.",
  "A worker handles one job at a time; the queue is kept short by adding workers, not by making uploads wait.",
  "Storage and database tiers step up as retained files and results grow.",
  "Every figure is a monthly estimate for the configuration shown, from Zenith’s static estimate tables. It is not a bill and not a forecast.",
];

/** The node that contributes most to a configuration's estimate. */
export function costDriver(manifest: Manifest): ExampleNodeId {
  return EXAMPLE_NODE_IDS.reduce((best, id) => nodeCost(manifest, id) > nodeCost(manifest, best) ? id : best, EXAMPLE_NODE_IDS[0]);
}

/** The order a request travels the system, for the animated light. `reverse` travels against the drawn arrow. */
export const FLOW_STORY: Record<"current" | "proposed", FlowStep[]> = {
  current: [{ edge: "route-api" }, { edge: "api-uploads" }, { edge: "api-results" }],
  proposed: [{ edge: "route-api" }, { edge: "api-uploads" }, { edge: "api-jobs" }, { edge: "worker-jobs", reverse: true }, { edge: "worker-uploads" }, { edge: "worker-results" }],
};

/* ------------------------------ your agents ------------------------------ */

export interface AgentStep {
  title: string;
  text: string;
  /** the example request, when a step has one */
  quote?: string;
}

/** The linking and approval sequence, as the public plugin documents it. */
export const AGENT_STEPS: AgentStep[] = [
  { title: "Install", text: "Add the Zenith plugin to Claude Code or Codex. Nothing changes in your account." },
  { title: "Link", text: "The agent shows a code. You open Zenith, check it matches, and sign in." },
  { title: "Scopes", text: "Workspace, projects and scopes. Read is always included; write only if you grant it." },
  { title: "Ask", text: "The agent reads your real workspace and prepares an exact change, with a digest.", quote: "Help me get this application ready to run on Zenith." },
  { title: "Approve", text: "You approve that exact digest in the browser. The agent cannot approve its own work." },
  { title: "Follow", text: "It executes once and reports what actually happened, uncertainty included." },
];
