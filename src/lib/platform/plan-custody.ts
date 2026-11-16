/**
 * Production composition seam for cross-worker plan custody (PROD-DUR-05).
 *
 * The paired runtime (platform/plan-artifacts.ts) already enforces tenant, fence, integrity (AEAD plus manifest
 * digest) and expiry inside its own transactions. This wrapper adds the worker-identity layer on every operation a
 * worker performs on an artifact: admission under the live fence, identity-bound unwrap verification before each read,
 * and a second verification immediately before the one dispatch compare-and-set, so a revoked or superseded worker
 * stops before it can apply a plan that another worker owns. Every admit and verify is audited, refusals included.
 * It never receives plaintext and cannot widen what the wrapped port allows.
 */
import type { PlanArtifactsPort } from "@/lib/execution/ports";
import type { Sql } from "@/lib/controlplane/types";
import * as custody from "@/lib/controlplane/db/repos/plan-custody";
import type { ArtifactAccess } from "@/lib/controlplane/db/repos/plan-artifacts";
import { planCustodyCryptoFromEnv, type CustodyCrypto } from "./plan-custody-crypto";

export interface WorkerCustodyOptions {
  readonly db: Sql;
  readonly workerIdentity: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam only. Production always derives the crypto from the validated plan artifact keys. */
  readonly crypto?: CustodyCrypto;
}

export function withWorkerCustody(inner: PlanArtifactsPort, options: WorkerCustodyOptions): PlanArtifactsPort {
  const env = options.env ?? process.env;
  let crypto: CustodyCrypto | undefined = options.crypto;
  const cryptoNow = (): CustodyCrypto => crypto ??= planCustodyCryptoFromEnv(env);
  const { db, workerIdentity } = options;
  const port: PlanArtifactsPort = {
    kind: inner.kind,
    associate: input => inner.associate(input),
    async publish(input) {
      await inner.publish(input);
      const manifest = input.produced?.manifest;
      if (!manifest) throw new custody.PlanCustodyError("artifact_unavailable");
      const access: ArtifactAccess = { custody: { workspaceId: manifest.workspaceId, projectId: manifest.projectId, environmentId: manifest.environmentId,
        operationId: manifest.operationId, proposalDigest: manifest.proposalDigest, inputDigest: manifest.inputDigest, expiresAt: manifest.expiresAt,
        sourceDigest: manifest.sourceDigest, graphDigest: manifest.graphDigest }, planDigest: manifest.planDigest, lease: input.lease };
      await custody.admit(db, access, workerIdentity, cryptoNow());
    },
    async inspect(input, fn) {
      await custody.admit(db, input, workerIdentity, cryptoNow());
      await custody.verify(db, input, workerIdentity, cryptoNow(), "inspect_verified");
      return inner.inspect(input, fn);
    },
    async consume(input, fn) {
      await custody.admit(db, input, workerIdentity, cryptoNow());
      await custody.verify(db, input, workerIdentity, cryptoNow(), "inspect_verified");
      return inner.consume(input, (approved, dispatch) => fn(approved, async () => {
        await custody.verify(db, input, workerIdentity, cryptoNow(), "dispatch_verified");
        await dispatch();
      }));
    },
  };
  return Object.freeze(port);
}
