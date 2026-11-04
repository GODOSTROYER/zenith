/**
 * Runners and machines: connection state (online, reconnected and catching up,
 * offline, revoked), results still waiting on the host, and release state.
 * Read-only: revoking and registering stay on the admin API behind the
 * workspace admin role. Offline and revoked are derived by the control plane;
 * the spool and release lines are the agent's own report and are labelled so.
 */
import { ConnectionStatusBadge } from "@/components/platform/connection-status";
import { BrokerError } from "@/lib/capabilities/errors";
import { agentView } from "@/lib/runners/admin";
import { registryOf } from "@/lib/runners/ports";
import { getRunnerRuntime } from "@/lib/runners/runtime";
import { RunnerConfigError } from "@/lib/runners/types";
import { loadPage } from "../_lib/loaders";
import { PageState } from "../_components/page-state";

export const dynamic = "force-dynamic";

type AgentRow = ReturnType<typeof agentView>;

async function loadAgents(workspaceId: string): Promise<{ runners: AgentRow[]; machines: AgentRow[] }> {
  try {
    const rt = await getRunnerRuntime();
    const nowMs = rt.now();
    const [runners, machines] = await Promise.all([registryOf(rt.store, "runner").list(workspaceId), registryOf(rt.store, "machine").list(workspaceId)]);
    return { runners: runners.map((a) => agentView(a, nowMs)), machines: machines.map((a) => agentView(a, nowMs)) };
  } catch (error) {
    if (error instanceof RunnerConfigError) throw new BrokerError("signer_unavailable", "The runner plane is not configured on this instance, so runner and machine status is unavailable.");
    throw error;
  }
}

function AgentTable({ title, rows, empty }: { title: string; rows: AgentRow[]; empty: string }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[15px] font-medium">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-ink-mute">{empty}</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((a) => (
            <li key={a.id} className="space-y-1 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{a.name}</span>
                <ConnectionStatusBadge state={a.connection.state} title={a.connection.summary} />
                {a.version && <span className="text-[12px] text-ink-mute">Version {a.version}</span>}
              </div>
              <p className="text-[13px] text-ink-mute">{a.connection.summary}</p>
              {a.connection.releaseAttention && <p className="text-[13px] text-warn">{a.connection.releaseAttention}</p>}
              <p className="text-[12px] text-ink-mute">
                {a.lastHeartbeatAt ? (
                  <>
                    Last heard from <time dateTime={a.lastHeartbeatAt}>{a.lastHeartbeatAt}</time>
                  </>
                ) : (
                  "Has not sent a heartbeat yet"
                )}
                {a.connection.spooledResults > 0 && a.connection.state !== "offline" ? ` · ${a.connection.spooledResults} saved result${a.connection.spooledResults === 1 ? "" : "s"} being delivered (reported by the agent)` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function RunnersPage() {
  const result = await loadPage(async (context) => loadAgents(context.workspaceId));
  if ("error" in result) return <PageState {...result} />;
  const { runners, machines } = result.data;
  return (
    <div className="space-y-8">
      <h1 className="app-page-title">Runners and machines</h1>
      <p className="text-[13px] text-ink-mute">
        A runner or machine that stops sending heartbeats is shown as offline and receives no work. Results it finished while offline are saved on the host and delivered once it reconnects.
        A revoked one takes no work and is told to stop.
      </p>
      <AgentTable title="Runners" rows={runners} empty="No runners are registered in this workspace." />
      <AgentTable title="Machines" rows={machines} empty="No machines are registered in this workspace." />
    </div>
  );
}
