/**
 * Fake capability broker (`BrokerPort`) and fake credential broker
 * (`CredentialBroker`).
 *
 * The credential broker enforces the same purpose/capability rule the real
 * `AwsCredentialBroker` does (the deploy role only for a mutating capability,
 * the observe role only for a non-mutating one) and hands the callback an
 * `AwsSession` that is INVALID after the callback settles. Its `client()` builds
 * real AWS SDK clients; tests mock them with `aws-sdk-client-mock`, so a call the
 * activities make through the session is observable and nothing leaves the
 * process. The session carries secret canaries (`CANARY_SESSION_KEY`, in
 * `childProcessEnv()` and in the client credentials): tests assert they reach
 * nothing the activities return, store or emit.
 */
import { capability as lookupCapability, isCapability } from "@/lib/capabilities/catalog";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import { CredentialDeniedError, type AwsClientCtor, type AwsSession, type CredentialBroker, type CredentialRequest, type ProviderSession } from "@/lib/credentials/types";
import type { BrokerPort, FenceRef, PlanPolicyInput } from "@/lib/execution/ports";
import type { PolicyStepResult } from "@/lib/workflows/types";
import type { FakeOps } from "./store";
import { CANARY_SESSION_KEY, CANARY_GRANT } from "./fixtures";

export interface SessionRecord {
  connectionId: string;
  purpose: string;
  capability: string;
  fence?: number;
  durationSec?: number;
  grantEnv?: string;
  /** set when the callback settled */
  revoked: boolean;
  session: AwsSession;
}

export class FakeCredentialBroker implements CredentialBroker {
  readonly sessions: SessionRecord[] = [];
  /** refuse the next N requests */
  denyNext = 0;
  region = "us-east-1";
  accountId = "123456789012";

  async withSession<T>(req: CredentialRequest, fn: (session: ProviderSession) => Promise<T>): Promise<T> {
    if (this.denyNext > 0) {
      this.denyNext--;
      throw new CredentialDeniedError("The credential request was refused.", { reason: "grant_invalid" });
    }
    const grant = req.grant;
    if (!isCapability(grant.cap)) throw new CredentialDeniedError("unknown capability", { reason: "unknown_capability" });
    const mutates = lookupCapability(grant.cap).mutates;
    if (req.purpose === "deploy" && !mutates) throw new CredentialDeniedError(`Capability ${grant.cap} does not change anything, so it cannot use the deploy role.`, { reason: "purpose_capability_mismatch" });
    if (req.purpose === "observe" && mutates) throw new CredentialDeniedError(`Capability ${grant.cap} changes infrastructure and must use the deploy role.`, { reason: "purpose_capability_mismatch" });

    const region = this.region;
    let revoked = false;
    const session: AwsSession = {
      provider: "aws",
      accountId: this.accountId,
      region,
      expiresAt: "2099-01-01T00:00:00.000Z",
      transport: "emulator",
      client: <C>(ctor: AwsClientCtor<C>): C => {
        if (revoked) throw new Error("This session has ended.");
        return new ctor({ region, credentials: { accessKeyId: "ASIATESTSESSION0001", secretAccessKey: CANARY_SESSION_KEY, sessionToken: "session-token-canary" } });
      },
      childProcessEnv: () => ({ AWS_ACCESS_KEY_ID: "ASIATESTSESSION0001", AWS_SECRET_ACCESS_KEY: CANARY_SESSION_KEY, AWS_SESSION_TOKEN: "session-token-canary", AWS_REGION: region }),
    };
    const record: SessionRecord = {
      connectionId: req.connectionId,
      purpose: req.purpose,
      capability: grant.cap,
      ...(grant.fence !== undefined ? { fence: grant.fence } : {}),
      ...(req.durationSec !== undefined ? { durationSec: req.durationSec } : {}),
      ...(grant.env ? { grantEnv: grant.env } : {}),
      revoked: false,
      session,
    };
    this.sessions.push(record);
    try {
      return await fn(session);
    } finally {
      revoked = true;
      record.revoked = true;
    }
  }

  async verifyConnection(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "ok" };
  }
}

export class FakeBroker implements BrokerPort {
  readonly reevaluations: { operationId: string; plan?: PlanPolicyInput }[] = [];
  readonly grants: { operationId: string; audience: string; fence?: FenceRef; capability?: string; durationSec?: number }[] = [];
  outcome: PolicyStepResult = { outcome: "allow", decisionId: "dec-1", reasons: [] };
  approval: { approved: boolean; rejected: boolean; approvalId?: string } = { approved: false, rejected: false };
  refuseGrants = false;

  constructor(private readonly ops: FakeOps) {}

  async reevaluate(operationId: string, plan?: PlanPolicyInput): Promise<PolicyStepResult> {
    this.reevaluations.push({ operationId, ...(plan ? { plan } : {}) });
    return this.outcome;
  }

  async approvalStatus(): Promise<{ approved: boolean; rejected: boolean; approvalId?: string }> {
    return this.approval;
  }

  async issueGrant(operationId: string, audience: string, fence?: FenceRef, opts?: { capability?: string; durationSec?: number }): Promise<{ jws: string; claims: CapabilityGrantClaims }> {
    this.grants.push({ operationId, audience, ...(fence ? { fence } : {}), ...(opts?.capability ? { capability: opts.capability } : {}), ...(opts?.durationSec ? { durationSec: opts.durationSec } : {}) });
    if (this.refuseGrants) throw new Error("The broker refused to issue a grant.");
    const op = this.ops.ops.get(operationId) ?? (await this.ops.get(operationId));
    const now = Math.floor(Date.now() / 1000);
    const claims: CapabilityGrantClaims = {
      jti: `jti-${this.grants.length}`,
      iss: "zenith",
      aud: audience,
      sub: op?.principal.id ?? "user-1",
      iat: now,
      exp: now + 900,
      cap: opts?.capability ?? op?.capability ?? "deployment.deploy",
      op: operationId,
      digest: op?.proposalDigest ?? "a".repeat(64),
      ws: op?.workspaceId ?? "ws",
      ...(op?.projectId ? { proj: op.projectId } : {}),
      ...(op?.environmentId ? { env: op.environmentId } : {}),
      ...(op?.resourceId ? { res: op.resourceId } : {}),
      ...(fence ? { fence: fence.fenceToken } : {}),
    };
    return { jws: CANARY_GRANT, claims };
  }
}
