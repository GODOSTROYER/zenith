/** REST wire types. All platform imports are type-only; the client also runs
 * in a browser. Approval/rejection deliberately have no SDK methods. */
import type { CapabilityName, CapabilityRequest } from "@/lib/capabilities/catalog";
import type { AutonomyLevel, AutonomyView } from "@/lib/capabilities/autonomy";
import type { EventView, OperationDetail } from "@/lib/capabilities/operations";
import type { WorkspacePolicyView } from "@/lib/capabilities/policy-settings";
import type { CheckResult, OperationView, ProposeResult } from "@/lib/capabilities/types";
import type { OperationStatus } from "@/lib/controlplane/types";
import type { WorkspacePolicyOverrides } from "@/lib/policy";

export type { CapabilityRequest, CheckResult, OperationDetail, OperationView, ProposeResult, AutonomyView, WorkspacePolicyView };
export type PlatformAuth = { kind: "bearer"; token: string } | { kind: "cookie"; cookie?: string };
export interface PlatformClientOptions {
  /** Zenith origin, optionally with a deployment path prefix. No credentials in the URL. */
  baseUrl: string;
  auth: PlatformAuth;
  workspaceId?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export interface OperationsQuery {
  status?: OperationStatus | readonly OperationStatus[];
  projectId?: string;
  environmentId?: string;
  resourceId?: string;
  capability?: CapabilityName;
  limit?: number;
  cursor?: string;
}
export interface EventsQuery { afterSeq?: number; limit?: number }
export interface AutonomyUpdate { level: AutonomyLevel; expectedVersion?: number }
export interface PolicyUpdate { overrides: WorkspacePolicyOverrides; expectedVersion?: number }
export interface PlatformClient {
  proposeCapability(request: CapabilityRequest): Promise<ProposeResult>;
  checkCapability(request: CapabilityRequest): Promise<CheckResult>;
  listOperations(query?: OperationsQuery): Promise<{ operations: OperationView[]; nextCursor?: string }>;
  getOperation(id: string): Promise<OperationDetail>;
  listOperationEvents(id: string, query?: EventsQuery): Promise<{ events: EventView[] }>;
  cancelOperation(id: string, input?: { reason?: string }): Promise<{ operation: OperationView }>;
  getEnvironmentAutonomy(id: string): Promise<AutonomyView>;
  setEnvironmentAutonomy(id: string, input: AutonomyUpdate): Promise<AutonomyView>;
  getWorkspacePolicy(): Promise<WorkspacePolicyView>;
  setWorkspacePolicy(input: PolicyUpdate): Promise<WorkspacePolicyView>;
}
