/** Authenticated, write-once custody under the existing enc:plan-artifacts key purpose. */
import type { Sql } from "@/lib/controlplane/types";
import { TERMINAL_OPERATION_STATUSES } from "@/lib/controlplane/types";
import { canonical } from "@/lib/controlplane/digest";
import type { OperationsPort, LeasesPort } from "@/lib/execution/ports";
import { isolationArtifactDigest, type IsolationArtifact, type IsolationCustodyPort } from "@/lib/execution/isolation-custody";
import { TenantIsolationError, type TenantIsolationRequest } from "@/lib/providers/zenith/onboarding";
import type { VaultCipher } from "@/lib/secrets";
import { planArtifactCipherFromEnv } from "./plan-artifacts";

type Row = { artifact_digest: string; iv: string; auth_tag: string; ciphertext: string };
const refuse = (): never => { throw new TenantIsolationError("not_configured", "The reviewed isolation artifact is unavailable, changed or expired; nothing was dispatched."); };
export function createIsolationCustody(input: { db: Sql; ops: Pick<OperationsPort, "get">; leases: Pick<LeasesPort, "assertFence">; cipher?: VaultCipher; now?: () => Date }): IsolationCustodyPort {
  let cipher = input.cipher;
  const crypto = () => cipher ??= planArtifactCipherFromEnv();
  const now = input.now ?? (() => new Date());
  const ref = (request: TenantIsolationRequest, planDigest: string) => `isolation:${request.operationId}:${planDigest}`;
  async function scope(request: TenantIsolationRequest): Promise<IsolationArtifact["scope"]> {
    const op = await input.ops.get(request.operationId);
    if (!op || !op.environmentId || !op.projectId || TERMINAL_OPERATION_STATUSES.includes(op.status) || op.workspaceId !== request.tenant.workspaceId || op.environmentId !== request.tenant.environmentId
      || request.lease.scope !== `env:${op.environmentId}` || Date.parse(op.expiresAt) <= now().getTime() || !Number.isFinite(Date.parse(op.expiresAt))) return refuse();
    await input.leases.assertFence(request.lease.scope, request.lease.fenceToken);
    return { workspaceId: op.workspaceId, projectId: op.projectId, environmentId: op.environmentId, operationId: op.id, proposalDigest: op.proposalDigest, inputDigest: op.inputDigest, expiresAt: op.expiresAt };
  }
  function open(request: TenantIsolationRequest, planDigest: string, row: Row): IsolationArtifact {
    try {
      const artifact = JSON.parse(crypto().open(request.tenant.workspaceId, ref(request, planDigest), { iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext }).value) as IsolationArtifact;
      if (artifact.format !== "zenith.isolation-artifact.v1" || artifact.review.planDigest !== planDigest || isolationArtifactDigest(artifact) !== row.artifact_digest) refuse();
      return artifact;
    } catch { return refuse(); }
  }
  const read = async (request: TenantIsolationRequest, planDigest: string): Promise<Row> => {
    if (!/^[a-f0-9]{64}$/.test(planDigest)) refuse();
    const rows = await input.db.query<Row>("select artifact_digest,iv,auth_tag,ciphertext from platform.isolation_plan_custody where workspace_id=$1 and operation_id=$2 and plan_digest=$3", [request.tenant.workspaceId, request.operationId, planDigest]);
    if (!rows[0]) refuse();
    return rows[0];
  };
  return {
    async publish(request, value) {
      const artifact: IsolationArtifact = { format: "zenith.isolation-artifact.v1", scope: await scope(request), ...structuredClone(value) };
      const sealed = crypto().seal(request.tenant.workspaceId, ref(request, value.review.planDigest), canonical(artifact));
      const hash = isolationArtifactDigest(artifact);
      await input.db.query("insert into platform.isolation_plan_custody(workspace_id,operation_id,plan_digest,artifact_digest,iv,auth_tag,ciphertext) values ($1,$2,$3,$4,$5,$6,$7) on conflict (workspace_id,operation_id,plan_digest) do nothing", [request.tenant.workspaceId, request.operationId, value.review.planDigest, hash, sealed.iv, sealed.authTag, sealed.ciphertext]);
      const saved = open(request, value.review.planDigest, await read(request, value.review.planDigest));
      if (isolationArtifactDigest(saved) !== hash) refuse();
    },
    async inspect(request, planDigest, fn) {
      const expected = await scope(request);
      const artifact = open(request, planDigest, await read(request, planDigest));
      if (canonical(artifact.scope) !== canonical(expected)) refuse();
      // Re-read current authority after decryption and immediately before the guarded callback.
      if (canonical(await scope(request)) !== canonical(expected)) refuse();
      return fn(Object.freeze(artifact));
    },
  };
}
