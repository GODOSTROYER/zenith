/**
 * Runner credential custody (PROD-MACH-05), control-plane half.
 *
 * Two explicit runner credential modes, declared by the runner itself at
 * registration (label `zenith.credentialMode`, set by the Go runner from its
 * `credentialMode` config) and recorded on the agent record:
 *
 *   local_only  credentials come only from the customer's own environment (instance
 *               or container role, local profile, customer-IdP web identity). Zenith
 *               never sends, mints or receives credential material for this runner.
 *               A runner that registered without the label is a pre-mode runner and
 *               has only ever had local identity, so it is treated as local_only.
 *   federated   the runner's identity may be federated from Zenith's OIDC issuer.
 *               Still no static key material over the wire; the control plane
 *               knows the runner may hold Zenith-issued workload identity.
 *
 * A provider connection in `runner` mode promises local custody. It states the
 * mode it needs in `config.runnerCustody` (default `local_only`); dispatch against
 * it is refused unless the runner declares exactly that mode.
 *
 * Revoked bindings: `assertRunnerBinding` re-reads the connection from the store at
 * enqueue time (a copy loaded earlier may be stale) and refuses when the connection
 * is missing, revoked, not verified, in another workspace, no longer bound to this
 * runner or not in runner mode. There is no fallback: the refusal is a
 * `DispatchError`, never a retry through the worker's platform credentials.
 *
 * Inbound defence in depth: a result from a `local_only` runner that carries a
 * high-confidence credential shape is sanitized before it is sealed and the event
 * records that it happened (kinds only). The Go runner withholds such results
 * itself; this is the second layer.
 */
import type { ProviderConnection } from "@/lib/credentials/types";
import { detectCredentialShapes, sanitizeForModel } from "@/lib/security/result-sanitizer";
import type { AgentRecord } from "@/lib/runners/ports";

export const CREDENTIAL_MODE_LABEL = "zenith.credentialMode";
export const RUNNER_CREDENTIAL_MODES = ["local_only", "federated"] as const;
export type RunnerCredentialMode = (typeof RUNNER_CREDENTIAL_MODES)[number];

export type BindingRefusalCode = "binding_revoked" | "binding_unavailable" | "custody_mismatch";

export class RunnerBindingError extends Error {
  constructor(
    readonly code: BindingRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "RunnerBindingError";
  }
}

/** Looks a connection up by workspace and id. `null` when it does not exist in that workspace. */
export type ConnectionLookup = (workspaceId: string, connectionId: string) => Promise<ProviderConnection | null>;

/** The mode a registered runner declared; unknown or absent labels mean `local_only` (see module comment). */
export function runnerCredentialMode(agent: Pick<AgentRecord, "labels">): RunnerCredentialMode {
  const declared = agent.labels?.[CREDENTIAL_MODE_LABEL];
  return declared === "federated" ? "federated" : "local_only";
}

/** True when the label carries a value this build does not know. Such a runner is treated as local_only, never as federated. */
export function hasUnknownCredentialMode(agent: Pick<AgentRecord, "labels">): boolean {
  const declared = agent.labels?.[CREDENTIAL_MODE_LABEL];
  return declared !== undefined && !(RUNNER_CREDENTIAL_MODES as readonly string[]).includes(declared);
}

/** The custody a connection requires of its runner. */
export function requiredRunnerCustody(connection: Pick<ProviderConnection, "config">): RunnerCredentialMode {
  const wanted = (connection.config as { runnerCustody?: unknown }).runnerCustody;
  return wanted === "federated" ? "federated" : "local_only";
}

/**
 * Refuse dispatch unless `connection` is a live, verified, runner-mode binding of exactly `agent`
 * whose custody requirement the runner declares. Pure; the caller supplies a FRESH connection.
 */
export function checkRunnerBinding(connection: ProviderConnection | null, agent: AgentRecord, workspaceId: string): void {
  if (!connection || connection.workspaceId !== workspaceId) throw new RunnerBindingError("binding_unavailable", "The provider connection bound to this runner is not available in this workspace.");
  if (connection.status === "revoked" || connection.revokedAt !== undefined) throw new RunnerBindingError("binding_revoked", "The provider connection bound to this runner was revoked; nothing is dispatched and no other credential is used instead.");
  if (connection.status !== "verified") throw new RunnerBindingError("binding_unavailable", `The provider connection bound to this runner is ${connection.status.replace("_", " ")}.`);
  const config = connection.config as { mode?: string; runnerId?: string };
  if (config.mode !== "runner") throw new RunnerBindingError("binding_unavailable", "The provider connection is not in runner mode; runner dispatch is not a fallback for it.");
  if (config.runnerId !== agent.id) throw new RunnerBindingError("binding_unavailable", "The provider connection is bound to a different runner.");
  const need = requiredRunnerCustody(connection);
  const have = runnerCredentialMode(agent);
  if (need !== have) throw new RunnerBindingError("custody_mismatch", `The connection requires a ${need} runner; this runner declares ${have}${hasUnknownCredentialMode(agent) ? " (unrecognised label, treated as local_only)" : ""}.`);
}

export async function assertRunnerBinding(lookup: ConnectionLookup, agent: AgentRecord, workspaceId: string, connectionId: string): Promise<void> {
  let connection: ProviderConnection | null;
  try {
    connection = await lookup(workspaceId, connectionId);
  } catch {
    // Unable to prove the binding is live: refuse. Never dispatch on an unverifiable binding.
    throw new RunnerBindingError("binding_unavailable", "The provider connection could not be re-read; dispatch is refused.");
  }
  checkRunnerBinding(connection, agent, workspaceId);
}

export interface InboundCustodyOutcome {
  /** the value to store; the original when nothing needed replacing */
  value: unknown;
  /** credential shape kinds found (never values); empty when clean or when the runner is not local_only */
  kinds: string[];
}

/** Inbound result check for a local_only runner: high-confidence credential shapes are replaced by markers. */
export function sanitizeInboundResult(agent: Pick<AgentRecord, "labels">, value: unknown): InboundCustodyOutcome {
  if (runnerCredentialMode(agent) !== "local_only") return { value, kinds: [] };
  const kinds = detectCredentialShapes(value);
  if (kinds.length === 0) return { value, kinds: [] };
  return { value: sanitizeForModel(value, { valueRulesOnly: true }).value, kinds };
}
