/** Persistence port for release runs. Implemented in memory (tests) and over the platform store (`repos/release-pipelines.ts`). */
import type { MigrationApproval, ReleaseEvent, ReleaseKind, ReleaseRun, ReleaseState } from "./types";

export type NewRun = Omit<ReleaseRun, "version" | "createdAt" | "updatedAt" | "state"> & { state: "planned" };

export interface TransitionInput {
  workspaceId: string;
  id: string;
  /** the version the caller read; a stale caller loses */
  expectVersion: number;
  to: ReleaseState;
  /** only these columns may change; the digest and identity columns never do */
  patch?: Partial<Pick<ReleaseRun, "imageUri" | "sourceDigest" | "provenance" | "migration" | "rollout" | "readback" | "reason" | "previousDigest" | "restoresRunId">>;
  actor: string;
  detail: string;
}

export interface ReleaseStore {
  /** Insert, or return the existing run for (workspace, operation, service, kind). */
  insertRun(run: NewRun): Promise<{ run: ReleaseRun; created: boolean }>;
  getRun(workspaceId: string, id: string): Promise<ReleaseRun | null>;
  findRun(workspaceId: string, operationId: string, serviceAddress: string, kind: ReleaseKind): Promise<ReleaseRun | null>;
  listRuns(workspaceId: string, filter: { environmentId?: string; serviceAddress?: string; operationId?: string; revisionId?: string; states?: readonly ReleaseState[]; limit?: number }): Promise<ReleaseRun[]>;
  /** Compare-and-set on `version`. Returns null when another writer got there first. */
  transition(input: TransitionInput): Promise<ReleaseRun | null>;
  listEvents(workspaceId: string, runId: string): Promise<ReleaseEvent[]>;
  insertApproval(approval: Omit<MigrationApproval, "consumedAt">): Promise<{ approval: MigrationApproval; created: boolean }>;
  /** The newest unconsumed, unexpired approval for this exact binding. */
  findUsableApproval(workspaceId: string, bindingDigest: string, now: Date): Promise<MigrationApproval | null>;
  /** Single use: returns true only for the one caller that consumed it. */
  consumeApproval(workspaceId: string, id: string, now: Date): Promise<boolean>;
}
