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
  /** emit a human log line (info) or provider-native line (provider) */
  log: (line: string, stream?: "info" | "provider") => void;
  /** emit an output as soon as it is known (URLs appear the moment they exist) */
  output: (o: Output) => void;
  env: Environment;
  revision: Revision;
  deployment: Deployment;
  step: DeploymentStep;
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

  /** Turn a revision into ordered, estimated steps. Pure — no side effects. */
  planSteps(env: Environment, next: Manifest, previous?: Manifest): ProviderPlanStep[];

  /**
   * Execute one step. Must be idempotent per (deployment, step) — the engine
   * may retry after a crash. Throw to fail the step.
   */
  executeStep(rt: StepRuntime): Promise<void>;

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
