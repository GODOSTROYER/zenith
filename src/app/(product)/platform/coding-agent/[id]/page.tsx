/** One coding agent run: budgets, steps, safety report, the proposed plan and its approval, and the browser-only actions. */
import Link from "next/link";
import { notFound as missing } from "@/lib/capabilities/errors";
import { platformDb, repos } from "@/lib/controlplane/db";
import { assertAdoptable, AdoptionRefused } from "@/lib/coding-agent/proposal-sink";
import { runView } from "@/lib/coding-agent/view";
import type { ProposalArtifact } from "@/lib/coding-agent/types";
import { Card } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { loadPage } from "../../_lib/loaders";
import { PageState } from "../../_components/page-state";
import { AutoRefresh, RunControls } from "../run-controls";
import { BUDGET_LABEL, RUN_STATUS_LABEL, formatBudget, stopReasonText } from "../labels";

export const dynamic = "force-dynamic";

const BUDGETS = ["toolCalls", "inputTokens", "outputTokens", "wallTimeMs", "spendMicroUsd"] as const;

export default async function CodingAgentRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await loadPage(async (context, broker) => {
    if (context.role !== "admin") throw missing();
    const row = await repos.codingAgentRuns.getRun(await platformDb(), context.workspaceId, id);
    if (!row) throw missing();
    let operation: { id: string; status: string } | undefined;
    let adoptReason = "The run has not produced an approved proposal yet.";
    let adoptReady = false;
    if (row.proposalOperationId) {
      try {
        const detail = await broker.getOperationDetail({ workspaceId: context.workspaceId, operationId: row.proposalOperationId, principal: context.principal });
        operation = { id: detail.operation.id, status: detail.operation.status };
        try {
          assertAdoptable({ id: row.id, status: row.status, result: row.result as { artifact?: ProposalArtifact } | null, proposalOperationId: row.proposalOperationId }, detail.operation);
          adoptReady = true;
          adoptReason = "";
        } catch (error) {
          adoptReason = error instanceof AdoptionRefused ? error.message : "The proposal cannot be adopted.";
        }
      } catch {
        adoptReason = "The proposal operation could not be read.";
      }
    } else if (row.status === "completed") adoptReason = "This run had no target, so nothing was submitted for approval.";
    return { run: runView(row), operation, adoptReady, adoptReason };
  });
  if ("error" in result) return <PageState {...result} />;
  const { run, operation, adoptReady, adoptReason } = result.data;
  const status = String(run.status);
  const usage = run.usage as Record<string, number>;
  const limits = run.limits as Record<string, number>;
  const source = run.source as { repository: string; commit: string; root?: string };
  const artifact = (run.result as { artifact?: ProposalArtifact } | null)?.artifact ?? null;
  const manifest = artifact?.manifest as { services?: { name: string; kind: string }[]; resources?: { name: string; kind: string }[] } | undefined;
  const reason = stopReasonText(run.stopReason);
  const unsafe = run.unsafeAttempts as { tool: string; code: string }[];
  const signals = run.injectionSignals as string[];
  const toolCalls = run.toolCalls as Record<string, number>;
  return (
    <div className="space-y-5">
      <p className="text-[12px]"><Link className="text-signal hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal" href="/platform/coding-agent">All coding agent runs</Link></p>
      <h1 className="app-page-title">Coding agent run</h1>
      <AutoRefresh active={status === "running"} />
      <section aria-labelledby="run-summary" className="space-y-1 text-[13px]">
        <h2 id="run-summary" className="sr-only">Summary</h2>
        <p><span className="font-medium">{RUN_STATUS_LABEL[status] ?? status}.</span> {reason}</p>
        <p className="text-ink-mute">Repository {source.repository}{source.root ? ` (${source.root})` : ""} at commit <code>{source.commit.slice(0, 12)}</code>. Model {String(run.model)}. {String(run.steps)} model turns.</p>
        <p className="text-ink-mute">Task: {String(run.task)}</p>
      </section>

      <RunControls workspaceId={result.context.workspaceId} runId={String(run.id)} resumable={Boolean(run.resumable)} cancellable={Boolean(run.cancellable)} adoptReady={adoptReady} adoptReason={adoptReason} hasProject={Boolean(run.target)} />

      <Card title="Budgets" subtitle="Each is checked before every model or tool call; reaching one stops the run with a checkpoint.">
        <ul className="grid gap-3 sm:grid-cols-2">
          {BUDGETS.map((k) => {
            const used = usage[k] ?? 0;
            const max = limits[k] ?? 1;
            return (
              <li key={k} className="text-[13px]">
                <label htmlFor={`b-${k}`} className="flex justify-between"><span>{BUDGET_LABEL[k]}</span><span className="text-ink-mute">{formatBudget(k, used)} of {formatBudget(k, max)}</span></label>
                <progress id={`b-${k}`} className="mt-1 h-2 w-full" value={Math.min(used, max)} max={max} aria-label={`${BUDGET_LABEL[k]} used`} />
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title="Steps and safety report" subtitle="Computed by the platform from the run, not by the model.">
        <dl className="grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2">
          <dt className="text-ink-mute">Tools used</dt>
          <dd>{Object.keys(toolCalls).length ? Object.entries(toolCalls).map(([n, c]) => `${n} x${c}`).join(", ") : "none yet"}</dd>
          <dt className="text-ink-mute">Refused tool calls</dt>
          <dd>{unsafe.length === 0 ? "None" : `${unsafe.length}: ${unsafe.map((u) => `${u.tool} (${u.code.replaceAll("_", " ")})`).join(", ")}`}</dd>
          <dt className="text-ink-mute">Instruction-like text found in the repository</dt>
          <dd>{signals.length === 0 ? "None detected" : `${signals.length} pattern${signals.length === 1 ? "" : "s"} (${signals.map((s) => s.replaceAll("_", " ")).join(", ")}). Treated as data only; it granted nothing.`}</dd>
        </dl>
        <p className="mt-3 text-[12px] text-ink-mute">The fixed task, unsafe-action and recovery evaluation set is run by operators with <code>npm run eval:coding-agent</code>; its machine-readable report is written to <code>test-results/coding-agent-eval.json</code> and is not stored per run.</p>
      </Card>

      <Card title="Proposed plan" subtitle="A proposal only. A person and policy decide what happens next.">
        {!artifact ? (
          <p className="text-[13px] text-ink-mute">{status === "running" ? "The agent has not proposed a manifest yet." : "This run did not produce a manifest."}</p>
        ) : (
          <div className="space-y-3 text-[13px]">
            <p>Proposed for the {artifact.environmentClass} environment class, confidence {artifact.confidence}.</p>
            <ul className="list-disc pl-5">
              {(manifest?.services ?? []).map((s) => <li key={`s-${s.name}`}>Service {s.name} ({s.kind})</li>)}
              {(manifest?.resources ?? []).map((r) => <li key={`r-${r.name}`}>{r.kind} {r.name}</li>)}
              {!(manifest?.services?.length || manifest?.resources?.length) && <li>Nothing deployable was found.</li>}
            </ul>
            {artifact.unresolved.length > 0 && (
              <Callout tone="warn" title="A person must decide">
                <ul className="list-disc pl-5">{artifact.unresolved.map((u, i) => <li key={i}>{u}</li>)}</ul>
              </Callout>
            )}
            {operation ? (
              <p>
                Approval: this proposal is <strong>{operation.status.replaceAll("_", " ")}</strong>.{" "}
                <Link className="text-signal hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal" href={`/platform/operations/${encodeURIComponent(operation.id)}`}>Open the approval page</Link>
              </p>
            ) : (
              <p className="text-ink-mute">Not submitted for approval{run.target ? " yet" : ": this run had no target environment"}.</p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
