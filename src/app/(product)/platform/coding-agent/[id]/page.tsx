/** One coding agent run: budgets, steps, safety report, the proposed plan and its approval, and the browser-only actions. */
import Link from "next/link";
import { BrokerError, notFound as missing } from "@/lib/capabilities/errors";
import { platformDb, repos } from "@/lib/controlplane/db";
import { db } from "@/lib/db/store";
import { contentHash } from "@/lib/domain/types";
import { parseManifest } from "@/lib/resources/manifest-v2";
import { diffManifests } from "@/lib/domain/graph";
import type { BudgetLimits, Checkpoint } from "@/lib/coding-agent/types";
import type { AppRequirements } from "@/lib/analysis/types";
import { assertAdoptable, AdoptionRefused } from "@/lib/coding-agent/proposal-sink";
import { runView } from "@/lib/coding-agent/view";
import { assertRunSourceAccess } from "@/lib/coding-agent/platform";
import type { ProposalArtifact } from "@/lib/coding-agent/types";
import { Card } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { loadPage } from "../../_lib/loaders";
import { PageState } from "../../_components/page-state";
import { AutoRefresh, RunControls } from "../run-controls";
import { AnalysisFindings } from "../analysis-findings";
import { BUDGET_LABEL, RUN_STATUS_LABEL, formatBudget, stopReasonText } from "../labels";

export const dynamic = "force-dynamic";

const BUDGETS = ["toolCalls", "inputTokens", "outputTokens", "wallTimeMs", "spendMicroUsd"] as const;

export default async function CodingAgentRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await loadPage(async (context, broker) => {
    if (context.role !== "admin") throw missing();
    const row = await repos.codingAgentRuns.getRun(await platformDb(), context.workspaceId, id);
    if (!row) throw missing();
    try { await assertRunSourceAccess(row); } catch { throw new BrokerError("policy_unavailable", "Repository access could not be confirmed. Review source connections and retry before opening this analysis."); }
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
    const view = runView(row);
    const project = row.projectId ? db().projects.find(item => item.id === row.projectId && item.workspaceId === context.workspaceId) : undefined;
    const proposal = parseManifest((row.result as { artifact?: ProposalArtifact } | null)?.artifact?.manifest);
    const currentHash = project ? contentHash(project.workingManifest) : undefined;
    const baseHash = typeof view.baseManifestHash === "string" ? view.baseManifestHash : undefined;
    const conflict = !!project && (!baseHash || currentHash !== baseHash);
    if (conflict) { adoptReady = false; adoptReason = "The project changed since this analysis began. Review the differences and prepare a new proposal."; }
    const review = project && proposal.ok ? { projectSlug: project.slug, baseHash, currentHash, conflict, changes: diffManifests(project.workingManifest, proposal.manifest) } : undefined;
    return { run: view, operation, adoptReady, adoptReason, review };

  });
  if ("error" in result) return <PageState {...result} />;
  const { run, operation, adoptReady, adoptReason, review } = result.data;
  const status = String(run.status);
  const usage = run.usage as Record<string, number>;
  const limits = run.limits as Record<string, number>;
  const source = run.source as { repository: string; commit: string; root?: string; bindingId?: string; bindingVersion?: number; contextDir?: string };
  const artifact = (run.result as { artifact?: ProposalArtifact } | null)?.artifact ?? null;
  const manifest = artifact?.manifest as { services?: { name: string; kind: string }[]; resources?: { name: string; kind: string }[] } | undefined;
  const reason = stopReasonText(run.stopReason);
  const unsafe = run.unsafeAttempts as { tool: string; code: string }[];
  const signals = run.injectionSignals as string[];
  const toolCalls = run.toolCalls as Record<string, number>;
  const finalText = (run.result as { finalText?: unknown } | null)?.finalText;
  return (
    <div className="space-y-5">
      <p className="text-[12px]"><Link className="text-signal hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal" href="/platform/coding-agent">All repository analyses</Link></p>
      <h1 className="app-page-title">Gimbal analysis</h1>
      <AutoRefresh workspaceId={result.context.workspaceId} runs={status === "running" ? [{ id: String(run.id), status, version: Number(run.version) }] : []} refreshOnProgress />
      <section aria-labelledby="run-summary" className="space-y-1 text-[13px]">
        <h2 id="run-summary" className="sr-only">Summary</h2>
        <p><span className="font-medium">{RUN_STATUS_LABEL[status] ?? status}.</span> {reason}</p>
        <p className="text-ink-mute">Repository {source.repository}{source.root ? ` (${source.root})` : ""} at commit <code>{source.commit.slice(0, 12)}</code>. {run.mode === "static" ? "Static analysis." : `Model ${String(run.model)}. ${String(run.steps)} model turns.`}</p>
        <p className="text-ink-mute">Task: {String(run.task)}</p>
        {source.contextDir !== undefined && <p className="text-ink-mute">Build context: {source.contextDir || "repository root"}.</p>}
        {source.bindingId && <p className="text-[12px] text-ink-mute">Repository access version {source.bindingVersion}. Access is rechecked before continuation, adoption, and execution.</p>}
        {typeof run.payloadExpiresAt === "string" && <p className="text-[12px] text-ink-mute">Retained analysis content expires {new Date(run.payloadExpiresAt).toLocaleString()}. You can delete it earlier using the run actions.</p>}
      </section>

      <RunControls workspaceId={result.context.workspaceId} runId={String(run.id)} resumable={Boolean(run.resumable)} cancellable={Boolean(run.cancellable)} adoptReady={adoptReady} adoptReason={adoptReason} hasProject={Boolean(run.target)} runVersion={typeof run.version === "number" ? run.version : undefined} contentDeletable={status !== "running" && !run.payloadPurgedAt} handoffReady={status !== "running" && status !== "cancelled"} planningHref={`/platform/coding-agent?${new URLSearchParams({ ...(source.bindingId ? { bindingId: source.bindingId } : { repository: source.repository }), ref: source.commit, root: source.root ?? "", contextDir: source.contextDir ?? "" })}`} baseManifestHash={typeof run.baseManifestHash === "string" ? run.baseManifestHash : undefined} limits={limits as unknown as BudgetLimits} usage={usage as unknown as BudgetLimits} />

      <AnalysisFindings requirements={run.requirements as AppRequirements | null} coverage={run.coverage as Checkpoint["coverage"] | null} summary={typeof finalText === "string" ? finalText : undefined} status={status} />

      {review && <Card title="Review project changes" subtitle="Compared with the current working copy. Adoption stages these changes; deployment remains a separate action.">
        <div className="space-y-3 text-[13px]">
          {review.conflict && <Callout tone="warn" title="Project changed during analysis">This proposal’s base revision is no longer current. Start another run against the current project; the old proposal cannot overwrite those edits.</Callout>}
          <p className="text-[12px] text-ink-mute">Analysis base: <code>{review.baseHash ?? "not recorded"}</code>. Current project: <code>{review.currentHash}</code>.</p>
          {review.changes.items.length ? <ul className="divide-y divide-line">{review.changes.items.map(change => <li key={`${change.nodeType}-${change.nodeId}`} className="space-y-1 py-2"><strong className={change.op === "delete" ? "text-err" : undefined}>{change.op === "delete" ? "Remove" : change.op === "create" ? "Add" : "Update"} {change.nodeName}</strong><p className="text-ink-mute">{change.explanation}</p>{change.fields?.length ? <p className="text-[12px] text-ink-mute">Fields: {change.fields.map(field => field.field).join(", ")}</p> : null}</li>)}</ul> : <p>No infrastructure differences detected.</p>}
          {review.changes.warnings.map((warning, index) => <Callout key={index} tone="warn">{warning}</Callout>)}
          <Link href={`/p/${encodeURIComponent(review.projectSlug)}/source`} className="text-signal hover:underline">Open project infrastructure</Link>
        </div>
      </Card>}

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
        <p className="mt-3 text-[12px] text-ink-mute">Source instructions cannot expand tool permissions or approve a deployment. The analysis may be incomplete; review evidence and unresolved requirements before adoption.</p>
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
            {artifact.explanations.length > 0 && <details><summary className="cursor-pointer font-medium">Why this plan</summary><ul className="mt-2 list-disc space-y-1 pl-5">{artifact.explanations.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}
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
