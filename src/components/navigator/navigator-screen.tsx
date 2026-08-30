"use client";
/**
 * The Navigator surface.
 *
 * It is deliberately not a chat window: a goal produces a typed plan, the plan
 * is approved step by step, and execution is the same audited action path the
 * rest of the product uses. Nothing here can do anything you could not do
 * yourself from the System Map.
 */
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Button, Card, Chip, Skeleton, Tooltip } from "@/components/ui";
import { useProjectData } from "@/components/shell/project-context";
import { useShell } from "@/components/shell/shell-context";
import { useJson } from "@/lib/client/api";
import { cx } from "@/lib/format";
import type {
  AutonomyLevel,
  Deployment,
  Environment,
  NavigatorRun,
  SecurityFinding,
} from "@/lib/domain/types";
import { createRunAction, executeRunAction } from "@/lib/navigator/server-actions";
import { AutonomyDial } from "./autonomy-dial";
import { CommandBar } from "./command-bar";
import { NavigatorGlyph } from "./glyph";
import { RunHistory } from "./run-history";
import { RunPanel } from "./run-panel";

const PLANNER_NOTES = {
  deterministic:
    "Pattern-based planning. Set ANTHROPIC_API_KEY in .env.local to let Claude translate freeform goals into the same typed plan.",
  llm: "Claude translates your goal into the typed command grammar; the deterministic planner still decides every action, risk and approval. Falls back to pattern parsing if the API is unreachable.",
} as const;

export type PlannerModeProp = keyof typeof PLANNER_NOTES;

export function NavigatorScreen({
  slug,
  plannerMode = "deterministic",
}: {
  slug: string;
  plannerMode?: PlannerModeProp;
}) {
  const { project, environments, findings, deployments, refresh } = useProjectData();
  const shell = useShell();
  const autonomy: AutonomyLevel = shell.boot?.settings.autonomy ?? "approve";

  const [goal, setGoal] = useState("");
  const [run, setRun] = useState<NavigatorRun>();
  const [approvals, setApprovals] = useState<Set<string>>(new Set());
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();

  const runs = useJson<{ runs: NavigatorRun[] }>(`/api/navigator/runs?projectId=${project.id}`);
  // Follow the live run while it executes; the executor writes each step as it goes.
  const live = useJson<{ run: NavigatorRun }>(
    run && running ? `/api/navigator/runs/${run.id}` : null,
    800
  );
  const shown = (running && live.data?.run) || run;

  const prodEnvIds = useMemo(
    () => new Set(environments.filter((e) => e.class === "production").map((e) => e.id)),
    [environments]
  );

  const plan = useCallback(async () => {
    if (!goal.trim()) return;
    setPlanning(true);
    setError(undefined);
    const res = await createRunAction(project.id, goal);
    setPlanning(false);
    if (res.error || !res.run) {
      setError(`${res.error ?? "The Navigator could not plan that."} ${res.fix ?? ""}`.trim());
      return;
    }
    setRun(res.run);
    setApprovals(new Set());
    runs.refresh();
  }, [project.id, goal, runs]);

  const execute = useCallback(async () => {
    if (!run) return;
    setRunning(true);
    setError(undefined);
    const res = await executeRunAction(run.id, [...approvals]);
    setRunning(false);
    if (res.error || !res.run) {
      setError(`${res.error ?? "The run could not be executed."} ${res.fix ?? ""}`.trim());
      return;
    }
    setRun(res.run);
    runs.refresh();
    refresh(); // costs, findings and deployments all move when a run lands
  }, [run, approvals, runs, refresh]);

  const toggleApprove = useCallback((stepId: string, on: boolean) => {
    setApprovals((prev) => {
      const next = new Set(prev);
      if (on) next.add(stepId);
      else next.delete(stepId);
      return next;
    });
  }, []);

  return (
    <div className="mx-auto w-full max-w-[980px] space-y-7 px-6 py-7">
      <Header
        autonomy={autonomy}
        onAutonomyChanged={shell.refresh}
        loading={shell.loading && !shell.boot}
        plannerMode={plannerMode}
      />

      <Advisories
        findings={findings}
        deployments={deployments}
        environments={environments}
        slug={slug}
        onSuggest={setGoal}
      />

      <CommandBar value={goal} onChange={setGoal} onSubmit={plan} busy={planning} />

      {error && (
        <p className="rounded-ctl border border-err/30 bg-err-dim px-3 py-2 text-[12.5px] text-err">
          {error}
        </p>
      )}

      {shown && (
        <RunPanel
          run={shown}
          projectId={project.id}
          slug={slug}
          autonomy={autonomy}
          approvals={approvals}
          onToggleApprove={toggleApprove}
          onRun={execute}
          running={running}
          onSuggest={setGoal}
          prodEnvIds={prodEnvIds}
        />
      )}

      <Card title="Earlier runs" subtitle="Goals, steps and outcomes, kept for this project.">
        <RunHistory runs={runs.data?.runs} loading={runs.loading} activeRunId={shown?.id} />
      </Card>
    </div>
  );
}

/* --------------------------------- header --------------------------------- */

function Header({
  autonomy,
  onAutonomyChanged,
  loading,
  plannerMode,
}: {
  autonomy: AutonomyLevel;
  onAutonomyChanged: () => void;
  loading: boolean;
  plannerMode: PlannerModeProp;
}) {
  return (
    <header className="space-y-4">
      <div className="flex items-start gap-3">
        <span
          className={cx(
            "mt-0.5 grid h-9 w-9 place-items-center rounded-card border border-nav-accent/30",
            "bg-nav-dim text-nav-accent"
          )}
        >
          <NavigatorGlyph size={20} />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[20px] font-medium tracking-[-0.01em] text-ink">Navigator</h1>
            <Tooltip label={PLANNER_NOTES[plannerMode]}>
              <Chip tone={plannerMode === "llm" ? "nav" : "neutral"}>
                {plannerMode === "llm" ? "language parsing · Claude" : "deterministic planner"}
              </Chip>
            </Tooltip>
          </div>
          <p className="mt-0.5 max-w-[70ch] text-[13px] text-ink-mute">
            Plans and operates this system through the same typed actions you use. Every step is
            audited.
          </p>
        </div>
      </div>
      {loading ? (
        <Skeleton height={28} width="24rem" />
      ) : (
        <AutonomyDial level={autonomy} onChanged={onAutonomyChanged} />
      )}
    </header>
  );
}

/* -------------------------------- advisories ------------------------------- */

function Advisories({
  findings,
  deployments,
  environments,
  slug,
  onSuggest,
}: {
  findings: SecurityFinding[];
  deployments: Deployment[];
  environments: Environment[];
  slug: string;
  onSuggest: (goal: string) => void;
}) {
  const envIds = new Set(environments.map((e) => e.id));
  const fixable = findings.filter((f) => f.status === "open" && f.fix);
  const failed = deployments
    .filter(
      (d) => envIds.has(d.environmentId) && (d.status === "failed" || d.status === "rolled_back")
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const failedEnv = failed ? environments.find((e) => e.id === failed.environmentId) : undefined;

  if (fixable.length === 0 && !failed) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fixable.length > 0 && (
        <Advisory
          icon={<ShieldCheck className="h-4 w-4" />}
          title={`${fixable.length} security finding${fixable.length === 1 ? " has" : "s have"} a one-click fix`}
          body={`Each runs a registered action with its own plan and cost. ${fixable[0].title}${
            fixable.length > 1 ? `, and ${fixable.length - 1} more.` : "."
          }`}
          cta="Plan the fixes"
          onClick={() => onSuggest("Fix the security findings")}
          href={`/p/${slug}/security`}
          hrefLabel="Security"
        />
      )}
      {failed && (
        <Advisory
          icon={<AlertTriangle className="h-4 w-4" />}
          title={`The last deployment to ${failedEnv?.name ?? "an environment"} ${
            failed.status === "failed" ? "failed" : "was rolled back"
          }`}
          body={failed.error ?? failed.changeSummary}
          cta="Plan an investigation"
          onClick={() => onSuggest("Investigate the failed deployment")}
          href={`/p/${slug}/deploys`}
          hrefLabel="Deploys"
          tone="warn"
        />
      )}
    </div>
  );
}

function Advisory({
  icon,
  title,
  body,
  cta,
  onClick,
  href,
  hrefLabel,
  tone = "nav",
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  cta: string;
  onClick: () => void;
  href: string;
  hrefLabel: string;
  tone?: "nav" | "warn";
}) {
  return (
    <div
      className={cx(
        "animate-enter rounded-card border bg-bg2 px-4 py-3",
        tone === "warn" ? "border-warn/30" : "border-nav-accent/25"
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className={cx("mt-0.5", tone === "warn" ? "text-warn" : "text-nav-accent")}>
          {icon}
        </span>
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-medium text-ink">{title}</h3>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-mute">{body}</p>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="quiet" onClick={onClick}>
              {cta}
            </Button>
            <Link
              href={href}
              className="text-[12.5px] text-ink-faint transition-colors hover:text-ink"
            >
              {hrefLabel} →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
