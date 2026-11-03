/** Coding agent runs: bounded, checkpointed analyses that end in a proposal for approval, never a deployment. */
import Link from "next/link";
import { db } from "@/lib/db/store";
import { platformDb, repos } from "@/lib/controlplane/db";
import { runView } from "@/lib/coding-agent/view";
import { assertRunSourceAccess } from "@/lib/coding-agent/platform";
import { Card } from "@/components/ui/card";
import { loadPage } from "../_lib/loaders";
import { PageState } from "../_components/page-state";
import { AutoRefresh, StartRun, type StartTarget } from "./run-controls";
import { RUN_STATUS_LABEL, formatBudget } from "./labels";

export const dynamic = "force-dynamic";

interface Row {
  id: string;
  status: string;
  task: string;
  repository: string;
  model: string;
  spend: string;
  toolCalls: string;
  proposal: boolean;
  updatedAt: string;
}

export default async function CodingAgentPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const query = searchParams ? await searchParams : {};
  const value = (key: string) => typeof query[key] === "string" && query[key].length <= 250 ? query[key] : undefined;
  const initialSource = {
    bindingId: value("bindingId") ?? (value("repository") ? "public" : undefined),
    repository: value("repository"), ref: value("ref"), root: value("root"), contextDir: value("contextDir"),
  };
  const result = await loadPage(async (context) => {
    const admin = context.role === "admin";
    if (!admin) return { admin, rows: [] as Row[], targets: [] as StartTarget[], unavailable: false };
    const stored = await repos.codingAgentRuns.listRuns(await platformDb(), context.workspaceId, 50);
    const visible: typeof stored = [];
    // Retention belongs to each run, even when several runs share one source.
    // Check every row independently, with at most four provider reads in flight.
    for (let offset = 0; offset < stored.length; offset += 4) {
      const batch = await Promise.all(stored.slice(offset, offset + 4).map(async row => {
        try { await assertRunSourceAccess(row); return row; } catch { return null; }
      }));
      for (const row of batch) if (row) visible.push(row);
    }
    const rows = visible.map(runView);
    const targets: StartTarget[] = context.environments.flatMap((e) => {
      const projectId = db().environments.find((x) => x.id === e.id)?.projectId;
      return projectId ? [{ environmentId: e.id, projectId, label: `${db().projects.find(p => p.id === projectId)?.name ?? "Project"} / ${e.name} (${e.class})` }] : [];
    });
    return {
      admin,
      unavailable: visible.length !== stored.length,
      targets,
      rows: rows.map((r): Row => ({
        id: String(r.id),
        status: String(r.status),
        task: String(r.task),
        repository: String((r.source as { repository?: string }).repository ?? ""),
        model: String(r.model),
        spend: formatBudget("spendMicroUsd", (r.usage as { spendMicroUsd: number }).spendMicroUsd),
        toolCalls: `${(r.usage as { toolCalls: number }).toolCalls} of ${(r.limits as { toolCalls: number }).toolCalls}`,
        proposal: Boolean(r.proposalOperationId),
        updatedAt: String(r.updatedAt),
      })),
    };
  });
  if ("error" in result) return <PageState {...result} />;
  const { admin, rows, targets, unavailable } = result.data;
  return (
    <div className="space-y-5">
      <h1 className="app-page-title">Gimbal repository analysis</h1>
      <p className="text-[13px] text-ink-mute">
        Attach a repository, inspect its applications, and prepare a deployment proposal. Start with static analysis or choose bounded model reasoning. Every run names an exact commit; infrastructure changes follow the normal review and deployment path.
      </p>
      {!admin ? (
        <PageState error="Only workspace admins can start or manage coding agent runs." missing />
      ) : (
        <>
          <AutoRefresh active={rows.some((r) => r.status === "running")} />
          <Card title="Analyze your code" subtitle="Repository access and project choices stay attached to the analysis.">
            <StartRun workspaceId={result.context.workspaceId} targets={targets} initialSource={initialSource} initialEnvironmentId={value("environmentId")} />
          </Card>
          <Card title="Recent runs" padded={false}>
            {unavailable && <p className="border-b border-line p-4 text-[13px] text-ink-mute">Some analyses are hidden because current source access could not be confirmed. Review repository connections, then refresh.</p>}
            {rows.length === 0 ? (
              <p className="p-4 text-[13px] text-ink-mute">No accessible analyses to show. Start one above or check repository access.</p>
            ) : (
              <table className="w-full text-left text-[13px]">
                <caption className="sr-only">Coding agent runs, newest first</caption>
                <thead>
                  <tr className="border-b border-line text-[12px] text-ink-mute">
                    <th scope="col" className="px-4 py-2 font-medium">Run</th>
                    <th scope="col" className="px-4 py-2 font-medium">Status</th>
                    <th scope="col" className="px-4 py-2 font-medium">Tool calls</th>
                    <th scope="col" className="px-4 py-2 font-medium">Estimated spend</th>
                    <th scope="col" className="px-4 py-2 font-medium">Proposal</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-line last:border-0">
                      <th scope="row" className="px-4 py-2 font-normal">
                        <Link className="text-signal hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal" href={`/platform/coding-agent/${encodeURIComponent(r.id)}`}>
                          {r.repository}
                        </Link>
                        <span className="block max-w-[44ch] truncate text-[12px] text-ink-mute">{r.task}</span>
                      </th>
                      <td className="px-4 py-2">{RUN_STATUS_LABEL[r.status] ?? r.status}</td>
                      <td className="px-4 py-2">{r.toolCalls}</td>
                      <td className="px-4 py-2">{r.spend}</td>
                      <td className="px-4 py-2">{r.proposal ? "Submitted for approval" : "None"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
