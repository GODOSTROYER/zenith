/**
 * Per-request transport sessions. Cloud identity stays inside the broker callback;
 * Kubernetes uses the provider's credential builder and the connection's namespace
 * allowlist. The compact grant travels only to zenithd, never into evidence.
 * Sandbox requests obtain no credentials. Connection lookups must be tenant-scoped.
 */
import { capability } from "@/lib/capabilities/catalog";
import type { CredentialBroker, ProviderConnection } from "@/lib/credentials/types";
import { createKubernetesSession, type KubernetesSessionDeps } from "@/lib/providers/kubernetes/session";
import { MachineOperationError } from "./errors";
import type { KubernetesMachineSession, MachineSessionProvider, MachineSessionRequest } from "./types";

export interface MachineSessionOptions {
  credentials: CredentialBroker;
  grantJws: string;
  /** Resolved by the execution activity; checked again against the target workspace. */
  connection?: ProviderConnection;
  kubernetes?: KubernetesSessionDeps;
  sandbox?: boolean;
  signal?: AbortSignal;
  now?: () => Date;
}

export function createMachineSessionProvider(options: MachineSessionOptions): MachineSessionProvider {
  return {
    async withSession<T>(req: MachineSessionRequest, fn: (session: unknown) => Promise<T>): Promise<T> {
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
        // Kubernetes credentials have a separate builder and local namespace guards.
        if (c.config.provider !== "kubernetes" || !options.kubernetes) throw new MachineOperationError("denied", "Kubernetes requires a connection and credential resolver");
        const now = options.now ?? (() => new Date());
        const remaining = Math.floor((req.grant.exp * 1000 - now().getTime()) / 1000);
        if (remaining <= 0) throw new MachineOperationError("grant_expired", "the capability grant has expired");
        const session = await createKubernetesSession(c.config, { ...options.kubernetes, now, ttlSec: Math.min(remaining, options.kubernetes.ttlSec ?? 900) }, options.signal);
        let active = true;
        const expiresAt = new Date(Math.min(Date.parse(session.expiresAt), req.grant.exp * 1000)).toISOString();
        const scoped: KubernetesMachineSession = {
          provider: "kubernetes", server: session.server, expiresAt,
          namespaces: [...c.config.namespaces],
          kubeConfig() {
            if (!active || now().getTime() >= Date.parse(expiresAt)) throw new MachineOperationError("denied", "the Kubernetes machine session has ended");
            return session.kubeConfig();
          },
        };
        try { return await fn(scoped); } finally { active = false; }
      }
      throw new MachineOperationError("unsupported_transport", "this transport has no machine session provider");
    },
  };
}
