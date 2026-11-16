/** Direct-object custody. This format is deliberately distinct from an OpenTofu plan file. */
import { digest } from "@/lib/controlplane/digest";
import type { TenantIsolationPlan, TenantIsolationRequest } from "@/lib/providers/zenith/onboarding";
import type { K8sObject } from "@/lib/providers/kubernetes/types";

export interface IsolationReview {
  /** Deployment composite digest, or the isolation digest for a dedicated onboarding operation. */
  planDigest: string;
  semanticsDigest: string;
}
export interface IsolationArtifact {
  format: "zenith.isolation-artifact.v1";
  scope: { workspaceId: string; projectId: string; environmentId: string; operationId: string; proposalDigest: string; inputDigest: string; expiresAt: string };
  review: IsolationReview;
  isolationSemanticsDigest: string;
  plan: TenantIsolationPlan;
  objects: readonly K8sObject[];
}
export interface IsolationCustodyPort {
  publish(request: TenantIsolationRequest, input: Pick<IsolationArtifact, "review" | "isolationSemanticsDigest" | "plan" | "objects">): Promise<void>;
  inspect<T>(request: TenantIsolationRequest, planDigest: string, fn: (artifact: Readonly<IsolationArtifact>) => Promise<T>): Promise<T>;
}
export const isolationArtifactDigest = (artifact: IsolationArtifact): string => digest(artifact);
