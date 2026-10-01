/**
 * Types shared by the live-acceptance harness: the AWS access handle, the
 * scenario definition and the context a scenario runs in.
 *
 * A scenario is DATA plus functions, not a script: it declares what it needs,
 * what it does step by step, what passes it, what it proves and — just as
 * important — what it cannot prove. The runner turns the same definition into
 * a dry run (exact planned actions, no cloud calls) or a real run.
 */
import type { AwsClientCtor } from "@/lib/credentials/types";
import type { LiveConfig } from "./config";
import type { EvidenceRecorder } from "./evidence";
import type { LiveSession } from "./safety";
import type { ControlPlaneClient } from "./clients/control-plane";
import type { WorkflowClient } from "./clients/workflow";
import type { WorkerController } from "./clients/worker-control";
import type { McpClient } from "./clients/mcp";
import type { HttpProbe } from "./http-probe";

/**
 * An AWS access handle. Like the broker's `AwsSession` it exposes client
 * factories and a child-process environment, never the credentials themselves.
 *
 * `ambient` is the operator's own profile/environment (the sandbox account's
 * human owner): used for the bootstrap identity checks, for out-of-band changes
 * that simulate the outside world (Demos B and D break and modify things the
 * way a person or an outage would) and for cleanup. `broker` would be a session
 * from `AwsCredentialBroker` inside a worker; Zenith's own actions always go
 * through the control plane, never through this handle.
 */
export interface AwsAccess {
  readonly kind: "ambient" | "broker";
  readonly accountId: string;
  readonly region: string;
  client<C>(ctor: AwsClientCtor<C>, overrides?: { region?: string }): C;
  /** AWS_* variables for a child process (OpenTofu). Never persist or log the result. */
  childProcessEnv(): Promise<Record<string, string>>;
}

export const SCENARIO_IDS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/** What a prerequisite needs in order to be checked: only `offline` ones run in a dry run. */
export type PrerequisiteKind = "offline" | "control-plane" | "cloud";

export type PrerequisiteResult = { ok: true; detail?: string } | { ok: false; detail: string };

export interface PrerequisiteContext {
  config: LiveConfig;
  env: Readonly<Record<string, string | undefined>>;
  /** the scenarios that run before this one in the same run */
  earlier: readonly ScenarioId[];
  controlPlane?: ControlPlaneClient;
}

export interface Prerequisite {
  id: string;
  description: string;
  kind: PrerequisiteKind;
  check(ctx: PrerequisiteContext): Promise<PrerequisiteResult> | PrerequisiteResult;
}

/**
 * What a step does to the world. `none` is local computation; `read` reads a
 * cloud or the control plane; `mutate` changes cloud or control-plane state
 * (needs `--confirm-billable`, and the cost check for scenarios that create
 * resources).
 */
export type StepEffect = "none" | "read" | "mutate";

export interface StepResult {
  detail?: string;
}

export interface ScenarioStep {
  id: string;
  title: string;
  effect: StepEffect;
  /** The exact actions this step will take, in words. Printed by `--dry-run`. */
  plan(ctx: PlanContext): string[];
  run(ctx: ScenarioContext): Promise<StepResult | void>;
}

export interface PassCriterion {
  id: string;
  text: string;
}

export interface ScenarioDefinition {
  id: ScenarioId;
  title: string;
  summary: string;
  /** what the scenario needs to run for real */
  needs: { cloud: "none" | "aws" | "kubernetes" | "managed"; controlPlane: boolean; temporal: boolean };
  /** changes billable cloud resources or control-plane state: needs `--confirm-billable` */
  mutates: boolean;
  /** creates billable resources, so a cost estimate must pass the budget gate first */
  createsResources: boolean;
  /** scenarios that must run before this one in the same run (they leave the deployment this one acts on) */
  dependsOn: readonly ScenarioId[];
  prerequisites: readonly Prerequisite[];
  steps: readonly ScenarioStep[];
  /**
   * The observable conditions under which the scenario counts as passed. Each
   * has an id; a step records a check under that id. A criterion no step
   * recorded is reported as SKIPPED by the runner, never as passed.
   */
  passCriteria: readonly PassCriterion[];
  proves: readonly string[];
  /** what a pass does NOT establish; never empty */
  cannotProve: readonly string[];
  /** what stops this scenario running for real today (empty when nothing does) */
  blockedOn: readonly string[];
  /** can run end to end on this machine with no cloud */
  runsLocally: boolean;
  /** rough cost of one run, for the docs and the dry run */
  costNote: string;
  /**
   * Scenario-specific teardown the CLI runs in its `finally`, after the run's
   * steps and before the tag sweep (for example deleting a Kubernetes namespace
   * the cloud sweeper cannot see). Must tolerate a half-finished scenario.
   */
  cleanup?(ctx: ScenarioContext): Promise<void>;
}

/** What the dry run needs to describe steps without touching anything. */
export interface PlanContext {
  runId: string;
  config: LiveConfig;
  region?: string;
  accountId?: string;
}

export interface ScenarioContext {
  runId: string;
  config: LiveConfig;
  evidence: EvidenceRecorder;
  /** present for live cloud runs, absent for local ones */
  session?: LiveSession;
  controlPlane?: ControlPlaneClient;
  workflows?: WorkflowClient;
  worker?: WorkerController;
  mcp?: McpClient;
  probe: HttpProbe;
  /** values steps hand to later steps (and to later scenarios of the same run) */
  state: Map<string, unknown>;
  signal: AbortSignal;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(message: string): void;
  /** where scenario-local files (workspace copies, fixtures) may be written */
  scratchDir: string;
  /** `<evidence dir>/run-state.json`: what a later cleanup must know (see run-state.ts) */
  runStateFile: string;
}

/** AWS access of a live run; throws when the scenario was started without a live session. */
export function awsOf(ctx: ScenarioContext): AwsAccess {
  if (!ctx.session) throw new Error("This step needs a live AWS session; the run was started without one.");
  return ctx.session.aws();
}

export function requireClient<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not configured for this run.`);
  return value;
}
