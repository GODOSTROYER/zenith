/**
 * Per-request transport sessions. Cloud identity stays inside the broker callback;
 * Kubernetes takes its namespace allowlist from the broker's current session. The compact grant travels only to zenithd, never into evidence.
 * Sandbox requests obtain no credentials. Connection lookups must be tenant-scoped.
 */
import { capability } from "@/lib/capabilities/catalog";
import { CredentialDeniedError, type CredentialBroker, type ProviderConnection, type ProviderSession } from "@/lib/credentials/types";
import { createKubernetesSession, validateServerUrl, type KubernetesSessionDeps } from "@/lib/providers/kubernetes/session";
import { isDnsLabel } from "@/lib/providers/kubernetes/naming";
import { guestProfileFor } from "@/lib/providers/kubernetes/guest";
import { MachineOperationError } from "./errors";
import type { KubernetesMachineSession, MachineSessionProvider, MachineSessionRequest } from "./types";

export interface MachineSessionOptions {
  credentials: CredentialBroker;
  grantJws: string;
  /** Resolved by the execution activity; checked again against the target workspace. */
  connection?: ProviderConnection;
  /** NODE_ENV=test only: compatibility adapter, captured once and never used by production. */
  kubernetes?: KubernetesSessionDeps;
  sandbox?: boolean;
  signal?: AbortSignal;
  now?: () => Date;
}

function requireIsolatedKubernetesTest(): void {
  if (process.env.NODE_ENV !== "test") throw new MachineOperationError("denied", "isolated Kubernetes credential adapters are available only in tests");
}

/** Only the callback-scoped broker handle can hand out its credential object. */
async function withKubernetesMachineSession<T>(
  session: ProviderSession,
  grantExpiresAt: number,
  now: () => Date,
  signal: AbortSignal | undefined,
  fn: (session: unknown) => Promise<T>,
): Promise<T> {
  const candidate = session as Partial<KubernetesMachineSession> | null;
  if (!candidate || candidate.provider !== "kubernetes" || typeof candidate.kubeConfig !== "function"
    || typeof candidate.server !== "string" || typeof candidate.expiresAt !== "string"
    || !Array.isArray(candidate.namespaces) || Array.from(candidate.namespaces).some(ns => typeof ns !== "string" || !isDnsLabel(ns))) {
    throw new MachineOperationError("denied", "the broker did not supply a scoped Kubernetes session");
  }
  let server: string;
  try { server = validateServerUrl(candidate.server); }
  catch { throw new MachineOperationError("denied", "the broker supplied an unusable Kubernetes endpoint"); }
  const sessionExpiresAt = Date.parse(candidate.expiresAt);
  if (!Number.isFinite(sessionExpiresAt)) throw new MachineOperationError("denied", "the broker supplied an unusable Kubernetes lifetime");
  const expires = Math.min(sessionExpiresAt, grantExpiresAt);
  let active = true;
  const usable = () => {
    if (signal?.aborted) throw new MachineOperationError("aborted", "the Kubernetes machine session was cancelled");
    if (!active || now().getTime() >= expires) throw new MachineOperationError("denied", "the Kubernetes machine session has ended");
  };
  const kubeConfig = candidate.kubeConfig.bind(candidate);
  const scoped: KubernetesMachineSession = Object.freeze({
    provider: "kubernetes" as const, server, expiresAt: new Date(expires).toISOString(),
    // Never add the captured connection's old namespaces to current broker scope.
    namespaces: Object.freeze([...candidate.namespaces]),
    kubeConfig() {
      usable();
      try { return kubeConfig(); }
      catch { throw new MachineOperationError("denied", "the Kubernetes machine session is unavailable"); }
    },
  });
  try {
    usable();
    const result = await fn(scoped);
    usable();
    return result;
  } finally { active = false; }
}

export function createMachineSessionProvider(options: MachineSessionOptions): MachineSessionProvider {
  const testSource = options.kubernetes;
  if (testSource) requireIsolatedKubernetesTest();
  const testKubernetes = testSource ? Object.freeze({ ...testSource }) : undefined;
  const now = options.now ?? (() => new Date());
  return {
    async withSession<T>(req: MachineSessionRequest, fn: (session: unknown) => Promise<T>): Promise<T> {
      if (testKubernetes) requireIsolatedKubernetesTest();
      if (options.sandbox) return fn(undefined);
      if (req.target.transport === "zenithd") return fn({ grantJws: options.grantJws });
      const c = options.connection;
      if (!c || c.workspaceId !== req.target.workspaceId || c.status !== "verified") {
        throw new MachineOperationError("denied", "the machine target has no verified connection in this workspace");
      }
      const purpose = capability(req.operation).mutates ? "deploy" : "observe";
      if (req.target.transport === "aws_ssm") {
        if (c.config.provider !== "aws") throw new MachineOperationError("denied", "SSM requires an AWS connection");
        return options.credentials.withSession({ connectionId: c.id, grant: req.grant, purpose }, async (session) => {
          if (session.provider !== "aws") throw new MachineOperationError("denied", "the broker did not supply an AWS session");
          return fn(session);
        });
      }
      if (req.target.transport === "azure_run_command" || req.target.transport === "gcp_os_management") {
        const provider = req.target.transport === "azure_run_command" ? "azure" : "gcp";
        if (c.config.provider !== provider) throw new MachineOperationError("denied", "the cloud machine transport requires a matching provider connection");
        return options.credentials.withSession({ connectionId: c.id, grant: req.grant, purpose }, async (session) => {
          if (session.provider !== provider) throw new MachineOperationError("denied", "the broker supplied a session for a different cloud provider");
          return fn(session);
        });
      }
      if (req.target.transport === "kubernetes") {
        if (c.config.provider !== "kubernetes") throw new MachineOperationError("denied", "Kubernetes requires a matching provider connection");
        if (req.grant.ws !== req.target.workspaceId || req.grant.op !== req.operationId || req.grant.cap !== req.operation
          || (req.grant.env !== undefined && req.grant.env !== req.target.environmentId)
          || (req.grant.res !== undefined && req.grant.res !== req.target.resourceId)
          || (capability(req.operation).scopeLevel === "resource" && req.grant.res === undefined)) {
          throw new MachineOperationError("grant_mismatch", "the capability grant does not authorize this Kubernetes target");
        }
        const expires = req.grant.exp * 1000;
        if (!Number.isSafeInteger(req.grant.exp) || !Number.isSafeInteger(expires) || !Number.isFinite(new Date(expires).getTime()) || expires <= now().getTime()) throw new MachineOperationError("grant_expired", "the capability grant has expired");
        if (options.signal?.aborted) throw new MachineOperationError("aborted", "the Kubernetes machine session was cancelled");
        // PROD-MACH-02: a scoped_guest connection is served ONLY by a per-dispatch minted, namespace- and
        // profile-scoped token. Neither the captured test resolver nor the minter/legacy credential may stand in.
        let kubernetesGuest: { namespace: string; profile: "read" | "exec" } | undefined;
        if (c.config.mode === "kubeconfig_ref" && !testKubernetes) {
          // Legacy broad credential: never handed to a guest. Explicit refusal with guidance, no fallback.
          throw new MachineOperationError("denied", "guest_credential_refused: this Kubernetes connection uses a legacy kubeconfig credential that is not scoped for guest sessions; convert it to a scoped guest connection (connection.rotate with convertToScopedGuest and a namespaced minter reference)");
        }
        if (c.config.mode === "scoped_guest") {
          if (testKubernetes) throw new MachineOperationError("denied", "a scoped Kubernetes guest connection cannot use a captured credential adapter");
          const namespace = req.target.targetId.split("/")[0];
          if (!isDnsLabel(namespace) || !c.config.namespaces.includes(namespace)) throw new MachineOperationError("denied", "the Kubernetes namespace is outside the connection's guest scope");
          kubernetesGuest = { namespace, profile: guestProfileFor(req.operation) };
        }
        if (testKubernetes) {
          const remaining = Math.floor((expires - now().getTime()) / 1000);
          const session = await createKubernetesSession(c.config, { ...testKubernetes, now, ttlSec: Math.min(remaining, testKubernetes.ttlSec ?? 900) }, options.signal);
          return withKubernetesMachineSession(session, expires, now, options.signal, fn);
        }
        let callbackEntered = false;
        try {
          return await options.credentials.withSession({ connectionId: c.id, grant: req.grant, purpose, ...(kubernetesGuest ? { kubernetesGuest } : {}) }, async session => {
            return withKubernetesMachineSession(session, expires, now, options.signal, async scoped => {
              callbackEntered = true;
              return fn(scoped);
            });
          });
        } catch (error) {
          // Callback failures retain their own semantics. Credential failures
          // before entry cannot surface vault/provider exception text or values.
          if (callbackEntered || error instanceof MachineOperationError) throw error;
          throw new MachineOperationError(error instanceof CredentialDeniedError && error.reason === "grant_expired" ? "grant_expired" : "denied",
            "the credential broker refused the Kubernetes machine session");
        }
      }
      throw new MachineOperationError("unsupported_transport", "this transport has no machine session provider");
    },
  };
}
