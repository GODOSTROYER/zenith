/** Runner readiness only. Never exchange credentials or probe a cloud here. */
import type { ConnectionConfig } from "@/lib/credentials/types";
import type { Sql } from "@/lib/controlplane/types";
import { repos } from "@/lib/controlplane/db";
import { requiredRunnerCustody, runnerCredentialMode } from "@/lib/runners/custody";
import { servedProtocols } from "@/lib/runners/protocol-window";
import { RUNNER_PROTOCOL_WINDOW } from "@/lib/runners/types";

export const RUNNER_VERIFICATION_SCOPE = "Runner registration, heartbeat, protocol, advertised job kind and credential custody only; cloud identity, target connectivity and permissions remain unverified. Provider transports that are unavailable remain refused.";
const KIND = { aws: "aws.http", gcp: "tofu.run", azure: "tofu.run", oci: "oci.http", kubernetes: "k8s.http" } as const;

export async function verifyRunnerReadiness(sql: Sql, workspaceId: string, config: ConnectionConfig): Promise<{ ok: boolean; detail: string }> {
  const runnerId = "runnerId" in config ? config.runnerId : undefined;
  if (config.mode !== "runner" || !runnerId) return { ok: false, detail: "A registered runner binding is required." };
  const runner = await repos.runners.getRunner(sql, workspaceId, runnerId);
  if (!runner) return { ok: false, detail: "The runner is not registered in this workspace." };
  if (runner.status !== "active") return { ok: false, detail: "The runner is revoked." };
  if (runner.stale) return { ok: false, detail: "The runner heartbeat is stale." };
  if (!servedProtocols(RUNNER_PROTOCOL_WINDOW).includes(runner.protocol)) return { ok: false, detail: "The runner protocol is unsupported." };
  const kind = KIND[config.provider];
  if (!runner.capabilities.includes(kind)) return { ok: false, detail: `The runner does not advertise ${kind}.` };
  if (runnerCredentialMode(runner) !== requiredRunnerCustody({ config })) return { ok: false, detail: "The runner credential custody does not match this connection." };
  return { ok: true, detail: `Registered ${config.provider} runner is ready for ${kind}. ${RUNNER_VERIFICATION_SCOPE}` };
}
