/**
 * Provider credential composition. All exchanges and vault reads stay inside
 * withSession; audit failure refuses a session. OCI and non-AWS runner modes
 * are refused until their transports implement the shared session contract.
 * Evidence is contract only: no cloud connection was exercised live here.
 */
import { capability, isCapability } from "@/lib/capabilities/catalog";
import { repos } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import { AwsCredentialBroker, type AwsBrokerOptions } from "@/lib/credentials/aws";
import { mintWorkloadToken, type WorkloadTokenDeps } from "@/lib/credentials/oidc/issuer";
import { CredentialDeniedError, type CredentialBroker, type CredentialRequest, type DenialReason, type ProviderConnection, type ProviderSession } from "@/lib/credentials/types";
import { createGcpSession } from "@/lib/providers/gcp";
import { createAzureSession } from "@/lib/providers/azure";
import { createKubernetesSession } from "@/lib/providers/kubernetes";
import { createRunnerAwsTransportFactory } from "@/lib/runners/aws-runner-transport";
import { isVaultRef, readSecretValueAsync } from "@/lib/secrets";

export interface PlatformCredentialOptions {
  aws?: Pick<AwsBrokerOptions, "stsClient" | "oidc">;
  oidc?: WorkloadTokenDeps;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function platformCredentialBroker(db: Sql, options: PlatformCredentialOptions = {}): CredentialBroker {
  const now = options.now ?? (() => new Date());
  // The fixed resolver contract takes only an id. Use the scoped repository
  // after a trusted system lookup; no connection is exposed before ws checks.
  const resolveConnection = async (id: string): Promise<ProviderConnection | null> => {
    const rows = await db.query<{ workspace_id: string }>("select workspace_id from platform.provider_connections where id = $1", [id]);
    return rows[0] ? repos.connections.get(db, rows[0].workspace_id, id) : null;
  };
  const emit: NonNullable<AwsBrokerOptions["emit"]> = async (event) => {
    // authorizeRead deliberately has no operation row; verification likewise
    // uses a synthetic id. Keep correlation while respecting the event FK.
    const operation = event.operationId ? await repos.operations.get(db, event.workspaceId, event.operationId) : null;
    await repos.events.append(db, { ...event, operationId: operation?.id });
  };
  const aws = new AwsCredentialBroker({ ...options.aws, now, resolveConnection, emit, runnerTransport: createRunnerAwsTransportFactory() });

  return {
    async withSession<T>(req: CredentialRequest, fn: (session: ProviderSession) => Promise<T>): Promise<T> {
      // Workspace is available here, so non-AWS lookups are tenant-scoped in SQL.
      const grant = req?.grant;
      if (!grant?.ws || !grant.op) throw new CredentialDeniedError("No usable capability grant.", { reason: "grant_invalid" });
      const connection = await repos.connections.get(db, grant.ws, req.connectionId);
      if (connection?.config.provider === "aws") return aws.withSession(req, fn);
      const base = { workspaceId: grant.ws, operationId: grant.op, projectId: grant.proj, environmentId: grant.env, resourceId: grant.res, correlationId: grant.op };
      const deny = async (reason: DenialReason, message: string): Promise<never> => {
        await Promise.resolve(emit({ ...base, type: "credential.denied", data: { connectionId: req.connectionId, reason } })).catch(() => undefined);
        throw new CredentialDeniedError(message, { reason });
      };
      if (!Number.isFinite(grant.exp) || grant.exp <= Math.floor(now().getTime() / 1000)) return deny("grant_expired", "The capability grant expired.");
      if (!isCapability(grant.cap)) return deny("unknown_capability", "Unknown capability.");
      if (!connection) return deny("connection_not_found", "Connection not found in this workspace.");
      if (connection.status === "revoked") return deny("connection_revoked", "Connection revoked.");
      if (connection.status !== "verified") return deny("connection_not_verified", "Connection has not been verified.");
      if ((req.purpose === "deploy") !== capability(grant.cap).mutates) return deny("purpose_capability_mismatch", "Credential purpose does not match capability.");
      if (connection.config.provider === "oci") return deny("provider_unsupported", "OCI is runner-only; oci.http does not yet implement ProviderSession. No direct credentials can be issued.");
      if (connection.config.mode === "runner") return deny("mode_unsupported", "This provider's runner transport is not configured.");
      const remaining = grant.exp - Math.floor(now().getTime() / 1000);
      const duration = req.durationSec ?? 900;
      if (!Number.isInteger(duration) || duration < 1) return deny("duration_invalid", "Session duration must be positive integer seconds.");
      const ttlSec = Math.min(900, duration, remaining);
      const minimum = connection.config.provider === "kubernetes" ? 30 : 60;
      if (ttlSec < minimum) return deny("grant_expired", "Grant has too little lifetime for this provider session.");
      const mint = (audience: string) => mintWorkloadToken({ workspaceId: grant.ws, connectionId: connection.id, operationId: grant.op, capability: grant.cap, audience, ttlSec: Math.min(120, ttlSec) }, { ...options.oidc, now: now() });
      let session: ProviderSession;
      let close: () => void;
      try {
        switch (connection.config.provider) {
          case "gcp": {
            const handle = await createGcpSession({ connection: connection.config, purpose: req.purpose, mintSubjectToken: mint, fetchImpl: options.fetchImpl, now, lifetimeSec: ttlSec });
            session = handle; close = () => handle.close(); break;
          }
          case "azure": {
            const handle = await createAzureSession({ connection: connection.config, purpose: req.purpose, mintClientAssertion: mint, fetchImpl: options.fetchImpl, now, durationSec: ttlSec });
            session = handle; close = () => handle.revoke(); break;
          }
          case "kubernetes": {
            const handle = await createKubernetesSession(connection.config, { now, ttlSec, resolveCredential: async (ref) => {
              if (!isVaultRef(ref)) throw new Error("Only Zenith vault references are supported.");
              const value = await readSecretValueAsync(grant.ws, ref);
              if (!value) throw new Error("Vault credential is unavailable in this workspace.");
              return value;
            } });
            let ended = false;
            session = { provider: "kubernetes", server: handle.server, expiresAt: handle.expiresAt, namespaces: handle.namespaces, kubeConfig: () => {
              if (ended) throw new CredentialDeniedError("The session has ended.", { reason: "session_ended" });
              return handle.kubeConfig();
            } } as ProviderSession;
            close = () => { ended = true; }; break;
          }
        }
      } catch {
        return deny("not_supported", "Provider session could not be created; check federation or vault configuration.");
      }
      try {
        await emit({ ...base, type: "credential.assumed", data: { connectionId: connection.id, provider: connection.config.provider, purpose: req.purpose } });
        return await fn(session);
      } finally { close(); }
    },
    async verifyConnection(id, opts) {
      const connection = opts?.workspaceId ? await repos.connections.get(db, opts.workspaceId, id) : await resolveConnection(id);
      if (!connection) return { ok: false, detail: "Connection not found." };
      if (connection.config.provider === "aws") return aws.verifyConnection(id, opts);
      // Creating a federated session alone is not identity verification. Never
      // mark a pending connection verified without a provider identity check.
      return { ok: false, detail: "Non-AWS identity verification is not wired; connection remains unverified." };
    },
  };
}
