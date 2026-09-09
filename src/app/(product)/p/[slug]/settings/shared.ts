/** Pieces the Environments and Connections sections both read. */
import type { DotStatus } from "@/components/ui/status-dot";
import type { Bootstrap } from "@/components/shell/shell-context";
import type { CloudConnection } from "@/lib/domain/types";

/** The registry's own answer, with the region shape `/api/bootstrap` sends. */
export interface ProviderInfo {
  id: CloudConnection["provider"];
  displayName: string;
  availability: "available" | "preview" | "planned";
  tagline: string;
  regions: { id: string; label: string }[];
}

/**
 * shell-context types `regions` as `string[]`; the route returns `{id,label}[]`.
 * Correcting the shared type is its own item (dead-control row 43) — until then
 * this is the one place the difference is admitted out loud.
 */
export const providersOf = (boot: Bootstrap | undefined): ProviderInfo[] =>
  (boot?.providers ?? []) as unknown as ProviderInfo[];

export const CONN_DOT: Record<CloudConnection["status"], DotStatus> = {
  healthy: "ok",
  degraded: "warn",
  disconnected: "err",
  connecting: "info",
};

/**
 * Why a connection cannot be deployed through, or undefined when it can.
 *
 * Two reasons, both from live data rather than a hardcoded provider name: the
 * registry's availability, and the connection's own last check. A disconnected
 * connection used to be silently offered as a choice that always failed later.
 */
export function unusableReason(
  connection: CloudConnection,
  providerById: Map<string, ProviderInfo>
): string | undefined {
  const p = providerById.get(connection.provider);
  if (!p)
    return `this build has no ${connection.provider} adapter registered, so it cannot run a deployment`;
  if (p.availability === "preview")
    return `${p.displayName} is preview: Zenith plans and exports for it, but does not apply changes to it yet`;
  if (p.availability === "planned") return `${p.displayName} is planned, not implemented`;
  if (connection.status === "connecting")
    return "its first preflight check has not finished — run Check under Connections";
  if (connection.status !== "healthy")
    return `it is ${connection.status}: deploys through it are refused until a preflight check passes — run Check under Connections`;
  return undefined;
}
