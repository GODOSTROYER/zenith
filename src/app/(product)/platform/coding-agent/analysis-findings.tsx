import { Card } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import type { AppRequirements, Inference } from "@/lib/analysis/types";
import type { Checkpoint } from "@/lib/coding-agent/types";

interface Finding { title: string; detail?: string; confidence: string; evidence: string[] }
const directory = (root: string) => root || "repository root";
function findings<T>(items: Inference<T>[] | undefined, describe: (value: T) => { title: string; detail?: string }): Finding[] {
  return (items ?? []).map(item => ({
    ...describe(item.value), confidence: item.confidence,
    evidence: item.evidence.map(evidence => `${evidence.path}${evidence.line ? `:${evidence.line}` : ""}`),
  }));
}

/** Source-derived strings are rendered as text, never HTML or executable instructions. */
export function AnalysisFindings({ requirements, coverage, summary, status }: {
  requirements?: AppRequirements | null;
  coverage?: Checkpoint["coverage"] | null;
  summary?: string;
  status: string;
}) {
  const groups = requirements ? [
    { label: "Applications", items: findings(requirements.services, service => ({ title: `${service.name} · ${service.kind}`, detail: `${directory(service.root)}${service.note ? ` · ${service.note}` : ""}` })) },
    { label: "Runtimes and frameworks", items: [
      ...findings(requirements.runtimes, runtime => ({ title: `${runtime.language}${runtime.version ? ` ${runtime.version}` : ""}`, detail: directory(runtime.root) })),
      ...findings(requirements.frameworks, framework => ({ title: framework.name, detail: directory(framework.root) })),
    ] },
    { label: "Build requirements", items: findings(requirements.builds, build => ({ title: `${directory(build.root)} · ${build.strategy}`, detail: [build.dockerfile, build.note, build.needsDockerfile ? "A Dockerfile is required before an isolated build." : undefined].filter(Boolean).join(" · ") })) },
    { label: "Data stores and services", items: findings(requirements.datastores, store => ({ title: `${store.kind}${store.engine ? ` (${store.engine})` : ""}`, detail: `${directory(store.root)}${store.note ? ` · ${store.note}` : ""}` })) },
    { label: "Database migrations", items: findings(requirements.migrations, migration => ({ title: migration.tool, detail: `${directory(migration.root)}${migration.note ? ` · ${migration.note}` : ""}` })) },
    { label: "Required configuration", items: findings(requirements.envVars, variable => ({ title: variable.name, detail: `${variable.classification} · ${variable.roots.map(directory).join(", ")}` })) },
    { label: "Source findings", items: findings(requirements.findings, finding => ({ title: finding.detail, detail: finding.path })) },
  ].filter(group => group.items.length) : [];
  const partial = coverage?.truncated || requirements?.truncated;
  const stopped = status !== "completed" && status !== "running";
  const retained = coverage?.retainedFiles ?? requirements?.fileCount;
  const unknowns = requirements?.unknowns ?? [];
  const risks = requirements?.risks ?? [];
  return <Card title="Analysis findings" subtitle="Recorded requirements, evidence, and open questions for the inspected source.">
    <div className="space-y-4 text-[13px]">
      {stopped && <Callout tone="info">This run stopped before completing. These are the findings saved in its last checkpoint; they may be useful when resuming or continuing in Claude Code.</Callout>}
      {partial && <Callout tone="warn" title="Partial repository coverage">An intake limit truncated the source. Requirements may be missing; review the skipped files and open questions before adopting a proposal.</Callout>}
      {retained !== undefined && <div className="space-y-1 text-ink-mute">
        <p>Retained text files: <strong className="text-ink">{retained.toLocaleString()}</strong>. {coverage && <>Files opened or matched by model tools: <strong className="text-ink">{coverage.readPaths.length.toLocaleString()}</strong>.</>}</p>
        <p>Static detection examines retained manifests and source patterns. Files outside this bounded analysis can contain additional requirements.</p>
      </div>}
      {coverage && coverage.skipped.length > 0 && <details><summary className="cursor-pointer font-medium">Skipped during source intake</summary><ul className="mt-2 list-disc space-y-1 pl-5">{coverage.skipped.map(item => <li key={item.reason}>{item.count.toLocaleString()} · {item.reason.replaceAll("_", " ")}</li>)}</ul></details>}
      {coverage && coverage.readPaths.length > 0 && <details><summary className="cursor-pointer font-medium">Paths read or matched by model tools ({coverage.readPaths.length})</summary><ul className="mt-2 space-y-1">{coverage.readPaths.slice(0, 100).map(path => <li key={path} className="break-all"><code>{path}</code></li>)}</ul>{coverage.readPaths.length > 100 && <p className="mt-2 text-ink-mute">Showing the first 100 recorded paths.</p>}</details>}
      {summary && <section aria-label="Analysis summary" className="space-y-2"><h4 className="font-medium">Summary</h4><p className="whitespace-pre-wrap break-words text-ink-mute">{summary}</p></section>}
      {groups.length ? <div className="grid gap-4 md:grid-cols-2">{groups.map(group => <section key={group.label} className="min-w-0 space-y-2" aria-label={group.label}>
        <h4 className="font-medium">{group.label}</h4>
        <ul className="space-y-3">{group.items.slice(0, 50).map((item, index) => <li key={index} className="space-y-1 break-words">
          <p>{item.title}</p>{item.detail && <p className="text-ink-mute">{item.detail}</p>}
          <p className="text-[12px] text-ink-mute">{item.confidence} confidence{item.evidence.length ? ` · ${item.evidence.slice(0, 4).join(", ")}` : " · no source location recorded"}</p>
        </li>)}</ul>
        {group.items.length > 50 && <p className="text-[12px] text-ink-mute">Showing 50 of {group.items.length} recorded findings.</p>}
      </section>)}</div> : <p className="text-ink-mute">{requirements ? "No supported application requirements were detected. Review the open questions before deciding how to deploy this source." : "Structured requirements have not been recorded yet."}</p>}
      {unknowns.length > 0 && <section aria-label="Open questions" className="space-y-2"><h4 className="font-medium">Open questions ({unknowns.length})</h4><ul className="list-disc space-y-1 pl-5">{unknowns.map((question, index) => <li key={index}>{question}</li>)}</ul></section>}
      {risks.length > 0 && <Callout tone="warn" title="Requirements that need attention"><ul className="list-disc space-y-1 pl-5">{risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul></Callout>}
    </div>
  </Card>;
}
