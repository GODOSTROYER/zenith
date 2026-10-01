/**
 * Provider credential composition. All exchanges and vault reads stay inside
 * broker callbacks; audit failure refuses a session. Onboarding permits pending
 * connections only for an observe read, never for general withSession use.
 * OCI verification checks runner registration only, not live cloud access.
 * Evidence is contract only: no cloud connection was exercised live here.
 */
import { capability, isCapability } from "@/lib/capabilities/catalog";
import { randomUUID } from "node:crypto";
import { canonical } from "@/lib/controlplane/digest";
import { repos } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import { AwsCredentialBroker, type AwsBrokerOptions } from "@/lib/credentials/aws";
import { mintWorkloadToken, type WorkloadTokenDeps } from "@/lib/credentials/oidc/issuer";
import { CredentialDeniedError, type CredentialBroker, type CredentialRequest, type DenialReason, type ProviderConnection, type ProviderSession } from "@/lib/credentials/types";
import { createGcpSession } from "@/lib/providers/gcp";
import { createAzureSession } from "@/lib/providers/azure";
import { createKubernetesSession } from "@/lib/providers/kubernetes";
import { createK8sClient } from "@/lib/providers/kubernetes/client";
import { isDnsLabel } from "@/lib/providers/kubernetes/naming";
import { K8sError } from "@/lib/providers/kubernetes/types";
import type { KubernetesSessionDeps } from "@/lib/providers/kubernetes/session";
import { GcpAuthError, GcpSessionError } from "@/lib/providers/gcp/errors";
import { AzureTokenError, AzureRequestRefusedError } from "@/lib/providers/azure/credentials";
import { ApiException } from "@kubernetes/client-node";
import { RUNNER_PROTOCOL } from "@/lib/runners/types";
import { createRunnerAwsTransportFactory } from "@/lib/runners/aws-runner-transport";
import { isVaultRef, readSecretValueAsync } from "@/lib/secrets";

export interface PlatformCredentialOptions {
  aws?: Pick<AwsBrokerOptions, "stsClient" | "oidc">;
  oidc?: WorkloadTokenDeps;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Trusted worker token minters; vault resolution remains workspace-scoped. */
  kubernetes?: Pick<KubernetesSessionDeps, "eksToken" | "oidcToken">;
}

type ConnectionVerification = Awaited<ReturnType<CredentialBroker["verifyConnection"]>>;

/** Static local descriptions only: cloud error bodies and exception text are secret-bearing data. */
function verificationFailure(error: unknown): string {
  const http = (status: number | undefined) => Number.isInteger(status) && status! >= 100 && status! <= 599 ? ` (HTTP ${status})` : "";
  if (error instanceof GcpAuthError) {
    const reasons: Record<GcpAuthError["code"], string> = {
      invalid_connection: "GCP federation configuration is invalid",
      unsupported_mode: "GCP runner verification is unavailable",
      subject_token_unavailable: "Zenith OIDC token could not be minted",
      sts_exchange_failed: "GCP STS rejected the OIDC token; check issuer, audience and subject trust",
      sts_unavailable: "GCP STS is unavailable or timed out",
      impersonation_failed: "GCP observe service-account impersonation was denied; check workloadIdentityUser binding",
      impersonation_unavailable: "GCP IAM Credentials is unavailable or timed out",
      malformed_response: "GCP token exchange returned an unusable response",
    };
    return `${reasons[error.code]}${http(error.status)}.`;
  }
  if (error instanceof GcpSessionError) return "GCP observe session is expired, closed or refused the identity read.";
  if (error instanceof AzureTokenError) return `Azure Entra token exchange failed${http(error.status)}; check tenant, client and federated issuer/audience/subject trust.`;
  if (error instanceof AzureRequestRefusedError) return "Azure observe session refused the identity read (expired session or endpoint policy).";
  if (error instanceof K8sError) {
    const reasons: Partial<Record<K8sError["code"], string>> = {
      session_invalid: "Kubernetes credential or token minter is missing or invalid",
      session_expired: "Kubernetes credential has expired",
      unauthorized: "Kubernetes API rejected the credential",
      forbidden: "Kubernetes identity lacks get access to the default ServiceAccount in an allowlisted namespace",
      not_found: "Kubernetes allowlisted namespace or default ServiceAccount was not found",
      timeout: "Kubernetes API timed out", unreachable: "Kubernetes API could not be reached",
    };
    return `${reasons[error.code] ?? "Kubernetes connection configuration or API read failed"}.`;
  }
  if (error instanceof ApiException) {
    if (error.code === 401) return "Kubernetes API rejected the credential (HTTP 401).";
    if (error.code === 403) return "Kubernetes identity lacks get access to the default ServiceAccount in an allowlisted namespace (HTTP 403).";
    if (error.code === 404) return "Kubernetes allowlisted namespace or default ServiceAccount was not found (HTTP 404).";
    return `Kubernetes namespace identity read failed${http(error.code)}.`;
  }
  if (error instanceof CredentialDeniedError) return "Provider federation configuration or Zenith OIDC issuer is unavailable.";
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "Provider identity verification timed out or was aborted.";
  return "Provider identity verification could not reach the provider or received an unusable response.";
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

  // One private callback lifecycle for regular operations and onboarding.
  // The public broker still refuses pending connections for general use.
  const withProviderSession = async <T>(connection: ProviderConnection, purpose: "observe" | "deploy", ttlSec: number, operationId: string, cap: string, assumed: () => void | Promise<void>, fn: (session: ProviderSession) => Promise<T>): Promise<T> => {
    const mint = (audience: string) => mintWorkloadToken({ workspaceId: connection.workspaceId, connectionId: connection.id, operationId, capability: cap, audience, ttlSec: Math.min(120, ttlSec) }, { ...options.oidc, now: now() });
    const c = connection.config;
    let session: ProviderSession;
    let close: () => void;
    switch (c.provider) {
      case "gcp": {
        const handle = await createGcpSession({ connection: c, purpose, mintSubjectToken: mint, fetchImpl: options.fetchImpl, now, lifetimeSec: ttlSec });
        session = handle; close = () => handle.close(); break;
      }
      case "azure": {
        const handle = await createAzureSession({ connection: c, purpose, mintClientAssertion: mint, fetchImpl: options.fetchImpl, now, durationSec: ttlSec });
        session = handle; close = () => handle.revoke(); break;
      }
      case "kubernetes": {
        const handle = await createKubernetesSession(c, { ...options.kubernetes, now, ttlSec, resolveCredential: async (ref) => {
          if (!isVaultRef(ref)) throw new K8sError("session_invalid", "Only Zenith vault references are supported.");
          const value = await readSecretValueAsync(connection.workspaceId, ref);
          if (!value) throw new K8sError("session_invalid", "Vault credential is unavailable in this workspace.");
          return value;
        } });
        let ended = false;
        session = { provider: "kubernetes", server: handle.server, expiresAt: handle.expiresAt, namespaces: handle.namespaces, kubeConfig: () => {
          if (ended) throw new CredentialDeniedError("The session has ended.", { reason: "session_ended" });
          return handle.kubeConfig();
        } } as ProviderSession;
        close = () => { ended = true; }; break;
      }
      default: throw new CredentialDeniedError("This provider does not expose direct sessions.");
    }
    try { await assumed(); return await fn(session); } finally { close(); }
  };

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
      let created = false;
      try {
        return await withProviderSession(connection, req.purpose, ttlSec, grant.op, grant.cap, async () => {
          created = true;
          try { await emit({ ...base, type: "credential.assumed", data: { connectionId: connection.id, provider: connection.config.provider, purpose: req.purpose } }); }
          catch { return deny("audit_failed", "Credential audit could not be recorded; session refused."); }
        }, fn);
      } catch (error) {
        if (!created) return deny("not_supported", "Provider session could not be created; check federation or vault configuration.");
        throw error;
      }
    },
    async verifyConnection(id, opts) {
      let connection: ProviderConnection | null;
      try { connection = opts?.workspaceId !== undefined ? await repos.connections.get(db, opts.workspaceId, id) : await resolveConnection(id); }
      catch { return { ok: false, detail: "The connection could not be loaded." }; }
      if (!connection) return { ok: false, detail: "Connection not found." };
      if (connection.config.provider === "aws") return aws.verifyConnection(id, opts);
      if (connection.status === "revoked") return { ok: false, detail: "Connection revoked." };
      const config = connection.config;
      let result: ConnectionVerification;
      try {
        if (config.provider === "oci") {
          const runner = await repos.runners.getRunner(db, connection.workspaceId, config.runnerId);
          if (!runner) return { ok: false, detail: "OCI runner is not registered in this workspace." };
          if (runner.status === "revoked") return { ok: false, detail: "OCI runner is revoked." };
          if (runner.stale) return { ok: false, detail: "OCI runner heartbeat is stale." };
          if (runner.protocol !== RUNNER_PROTOCOL) return { ok: false, detail: "OCI runner protocol is unsupported." };
          if (!runner.capabilities.includes("oci.http")) return { ok: false, detail: "OCI runner does not advertise the oci.http kind." };
          result = { ok: true, detail: "Registered OCI runner advertises oci.http for this connection. OCI cloud identity and permissions are unverified." };
        } else {
          if (config.mode === "runner") return { ok: false, detail: "This provider's runner verification transport is unavailable." };
          if (config.provider === "kubernetes" && (!config.namespaces.length || config.namespaces.some((ns) => !isDnsLabel(ns)))) return { ok: false, detail: "Kubernetes verification requires valid allowlisted namespaces for a namespaced get." };
          const operationId = `verify-${randomUUID()}`;
          result = await withProviderSession(connection, "observe", 900, operationId, "connection.verify", async () => {
            try { await emit({ workspaceId: connection.workspaceId, operationId, correlationId: operationId, type: "credential.assumed", data: { connectionId: id, provider: config.provider, purpose: "observe" } }); }
            catch { throw new VerificationAuditError(); }
          }, async (session): Promise<ConnectionVerification> => {
            const signal = AbortSignal.timeout(30_000);
            if (session.provider === "gcp" || session.provider === "azure") {
              const url = session.provider === "gcp" ? `https://cloudresourcemanager.googleapis.com/v3/projects/${session.projectId}` : `https://management.azure.com/subscriptions/${session.subscriptionId}?api-version=2022-12-01`;
              const response = await session.authorizedFetch(url, { method: "GET", signal });
              if (!response.ok) {
                await response.body?.cancel().catch(() => undefined);
                const reason = response.status === 401 ? "credential was rejected" : response.status === 403 ? "observe identity lacks read permission" : response.status === 404 ? "configured project/subscription was not found" : "identity read failed";
                return { ok: false, detail: `${session.provider === "gcp" ? "GCP project" : "Azure subscription"} ${reason} (HTTP ${response.status}).` };
              }
              const body: unknown = await response.json();
              const field = session.provider === "gcp" ? "projectId" : "subscriptionId";
              const expected = session.provider === "gcp" ? session.projectId : session.subscriptionId;
              const actual = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>)[field] : undefined;
              if (typeof actual !== "string" || (session.provider === "azure" ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)) return { ok: false, detail: "Provider identity read returned a missing or mismatched project/subscription identifier." };
              return { ok: true, detail: `${session.provider === "gcp" ? "GCP observe service account read the configured project" : "Azure federated identity read the configured subscription"}.`, accountId: expected };
            }
            if (session.provider === "kubernetes" && config.provider === "kubernetes") {
              const client = createK8sClient(session, { signal });
              for (const namespace of [...new Set(config.namespaces)].sort()) {
                const account = await client.core.readNamespacedServiceAccount({ name: "default", namespace });
                if (account.metadata?.name !== "default" || account.metadata.namespace !== namespace) return { ok: false, detail: "Kubernetes namespace read returned an unusable or mismatched ServiceAccount." };
              }
              return { ok: true, detail: "Kubernetes credential read the default ServiceAccount in every allowlisted namespace. Additional permissions are unverified." };
            }
            return { ok: false, detail: "Provider identity verification is unsupported." };
          });
        }
        if (result.ok) {
          const current = await repos.connections.get(db, connection.workspaceId, id);
          if (!current || current.status === "revoked" || canonical(current.config) !== canonical(config)) return { ok: false, detail: "Connection was revoked, removed or changed during verification; verify the current configuration again." };
        }
        return result;
      } catch (error) {
        return { ok: false, detail: error instanceof VerificationAuditError ? "Credential verification audit could not be recorded; verification refused." : verificationFailure(error) };
      }
    },
  };
}

class VerificationAuditError extends Error {}
