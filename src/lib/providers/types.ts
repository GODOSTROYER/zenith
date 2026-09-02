/**
 * Provider adapter contract. Sandbox implements it fully; AWS implements
 * planning + export (Preview); the rest are Planned and not selectable.
 *
 * Honesty rule (non-negotiable, from the category audit): a provider's
 * `availability` drives every label in the UI. Never present "planned"
 * as available.
 *
 * SPINE FILE — owned by the integrator.
 */
import type {
  CloudConnection,
  Deployment,
  DeploymentStep,
  Environment,
  Manifest,
  Output,
  ProviderId,
  ResourceKind,
  Revision,
} from "@/lib/domain/types";

export type ProviderAvailability = "available" | "preview" | "planned";

export interface PreflightCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail?: string;
  /** what to do about a warn/fail */
  fix?: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
  /** exact permission summary shown to the user */
  permissions: string[];
}

export interface ProviderPlanStep {
  phase: DeploymentStep["phase"];
  title: string;
  targetId: string;
  /** estimated duration in ms — drives progress UI honestly */
  estMs: number;
  /** provider-native description (terraform address, api call, …) */
  detail?: string;
}

export interface StepRuntime {
  /** aborted when the step's deadline expires; adapters should stop work and reject */
  signal: AbortSignal;
  /** emit a human log line (info) or provider-native line (provider) */
  log: (line: string, stream?: "info" | "provider") => void;
  /** emit an output as soon as it is known (URLs appear the moment they exist) */
  output: (o: Output) => void;
  env: Environment;
  revision: Revision;
  deployment: Deployment;
  step: DeploymentStep;
}

/**
 * How long the engine budgeted for this step.
 *
 * `ProviderPlanStep.estMs` is the estimate an adapter *asked* for; the engine
 * stores the granted budget per step id on the deployment, after collapsing it
 * for fast mode. Reading `step.estMs` gets you `undefined` — the engine never
 * copies it onto the step — which is why this lives in one place.
 */
export function stepBudgetMs(rt: StepRuntime, fallback = 800): number {
  const d = rt.deployment as Deployment & { estMs?: Record<string, number> };
  return d.estMs?.[rt.step.id] ?? fallback;
}

/**
 * Result of a provider's cheap liveness check. Distinct from `preflight`,
 * which needs a connection and reports on permissions: a probe answers only
 * "could a deploy to this provider start right now?", with no connection and
 * no credentials.
 */
export interface ProviderProbe {
  reachable: boolean;
  /** one line for the UI: what was tried, and what came back */
  detail: string;
  /** what to do about it — present whenever `reachable` is false */
  fix?: string;
}

export interface ExportFile {
  path: string;
  content: string;
}

export interface ExportBundle {
  files: ExportFile[];
  /** how to keep operating without Orrery — the no-lock-in document */
  readme: string;
}

/* ------------------------------- live state ------------------------------- */

/**
 * One node as the provider actually found it.
 *
 * `attributes` holds ONLY what the provider genuinely inspected. Drift compares
 * the intersection of these keys with what the manifest expects, so an adapter
 * that cannot see a field never produces drift on it — silence is "not looked
 * at", never "matches".
 */
export interface LiveResource {
  /** manifest node id; "" when the provider found something the manifest does not know */
  nodeId: string;
  /** ResourceKind or ServiceKind, as a string — providers report both */
  kind: string;
  exists: boolean;
  attributes: Record<string, string | number | boolean>;
  observedAt: string;
}

/**
 * What `observe` found. `simulated` is the honesty flag the UI renders: true
 * means nothing outside Orrery was inspected and the numbers were generated.
 */
export interface LiveState {
  simulated: boolean;
  observedAt: string;
  resources: LiveResource[];
}

/** Something present in the account/endpoint that the manifest does not own. */
export interface DiscoveredResource {
  /** provider-side identifier — the value stored on `Resource.externalRef` */
  externalRef: string;
  kind: ResourceKind;
  name: string;
  attributes: Record<string, string | number | boolean>;
}

/**
 * What `discover` found. Wrapped rather than a bare array for the same reason
 * as `LiveState`: the `simulated` flag belongs to the call, not to each row,
 * and an empty result still has to be able to say which kind of nothing it is.
 */
export interface Discovery {
  simulated: boolean;
  resources: DiscoveredResource[];
}

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  availability: ProviderAvailability;
  /** honest one-liner shown in pickers, including what "preview" means */
  tagline: string;
  regions: { id: string; label: string }[];

  /** Explain exactly what access is needed and why, before connecting. */
  accessExplanation(): { summary: string; permissions: string[] };

  /** Validate/inspect a connection. Sandbox always passes; AWS checks env creds. */
  preflight(conn: CloudConnection): Promise<PreflightReport>;

  /**
   * Cheap, connection-free reachability check, for surfaces that offer a
   * provider before any connection exists — onboarding's "Available now" list
   * above all. Must be safe to call on render: no writes, one request, its own
   * short timeout.
   *
   * Optional, and its absence is meaningful: a provider omits it when nothing
   * local can be down (the sandbox runs in-process; AWS Preview only plans and
   * exports). `availability` still decides selectability — a probe only says
   * whether an available provider can be used *right now*.
   */
  probe?(): Promise<ProviderProbe>;

  /** Turn a revision into ordered, estimated steps. Pure — no side effects. */
  planSteps(env: Environment, next: Manifest, previous?: Manifest): ProviderPlanStep[];

  /**
   * Execute one step. Must be idempotent per (deployment, step) — the engine
   * may retry after a crash. Throw to fail the step.
   */
  executeStep(rt: StepRuntime): Promise<void>;

  /**
   * Read back what actually exists for this environment's nodes, so drift can
   * be computed against the deployed revision. Read-only: an adapter must
   * never create, mutate or delete anything here.
   *
   * Optional, and its absence is meaningful — it says this provider cannot see
   * the environment at all, which is the honest answer for every Planned
   * provider. AWS Preview implements it and *refuses*, because "no code path
   * reads your account" is a different statement from "not built yet".
   */
  observe?(env: Environment, deployed: Manifest): Promise<LiveState>;

  /**
   * List resources present in the account/endpoint that the manifest does not
   * know about, for reference-import. Read-only, same rule as `observe`.
   */
  discover?(conn: CloudConnection, region?: string): Promise<Discovery>;

  /** Generate the no-lock-in export bundle (Terraform/OpenTofu + docs). */
  exportBundle(env: Environment, manifest: Manifest): ExportBundle;
}

/* -------------------------------- registry -------------------------------- */

type G = typeof globalThis & { __orreryProviders?: Map<ProviderId, ProviderAdapter> };

export function providerRegistry(): Map<ProviderId, ProviderAdapter> {
  const g = globalThis as G;
  if (!g.__orreryProviders) g.__orreryProviders = new Map();
  return g.__orreryProviders;
}

export function registerProvider(p: ProviderAdapter): void {
  providerRegistry().set(p.id, p);
}

export function getProvider(id: ProviderId): ProviderAdapter {
  const p = providerRegistry().get(id);
  if (!p) throw new Error(`Provider "${id}" is not registered.`);
  return p;
}
