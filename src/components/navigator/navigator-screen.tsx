"use client";
/**
 * The Navigator surface.
 *
 * It is deliberately not a chat window: a goal produces a typed plan, the plan
 * is approved step by step, and execution is the same audited action path the
 * rest of the product uses. Nothing here can do anything you could not do
 * yourself from the System Map.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { Skeleton } from "@/components/ui/skeleton";
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
import type { Parsing } from "@/lib/navigator/llm";
import {
  cancelRunAction,
  createRunAction,
  executeRunAction,
} from "@/lib/navigator/server-actions";
import { planBlock, type WorkspaceRole } from "@/lib/navigator/shared";
import { AutonomyDial } from "./autonomy-dial";
import { CommandBar } from "./command-bar";
import { NavigatorGlyph, type GimbalState } from "./glyph";
import { GIMBAL_STATES } from "./gimbal-contract";
import { gimbalPresentationFor, type GimbalPresentation } from "./gimbal-state";
import { GimbalCharacter } from "./gimbal-character";
import { GimbalStatus } from "./gimbal-status";
import { RunHistory } from "./run-history";
import { RunPanel } from "./run-panel";
import styles from "./navigator.module.css";

const PLANNER_NOTES = {
  deterministic:
    "Pattern-based planning translates supported requests into a typed plan. Review every action before running it.",
  llm: "Claude translates your goal into the typed command grammar; the deterministic planner still decides every action, risk and approval. Each plan below says which of the two actually read it.",
} as const;

export type PlannerModeProp = keyof typeof PLANNER_NOTES;

/** A run is still live if it is running, or paused waiting on an approval. */
const isLive = (r: NavigatorRun) => r.status === "executing" || r.status === "awaiting_approval";

export function NavigatorScreen({
  slug,
  plannerMode = "deterministic",
  plannerModel,
}: {
  slug: string;
  plannerMode?: PlannerModeProp;
  plannerModel?: string;
}) {
  const { project, environments, findings, deployments, refresh } = useProjectData();
  const shell = useShell();
  const autonomy: AutonomyLevel = shell.boot?.settings.autonomy ?? "approve";
  // null in demo mode (no auth configured), where the local actor is admin.
  const role = shell.boot?.role ?? null;

  const [goal, setGoal] = useState("");
  const [run, setRun] = useState<NavigatorRun>();
  const [parsing, setParsing] = useState<Parsing>();
  const [approvals, setApprovals] = useState<Set<string>>(new Set());
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string>();
  const [characterVisible, setCharacterVisible] = useState(true);

  const runs = useJson<{ runs: NavigatorRun[] }>(`/api/navigator/runs?projectId=${project.id}`);

  // `executeRun` is one long server action: navigating away drops the panel but
  // not the run. On arrival, adopt whatever is still live for this project so
  // coming back shows it mid-flight rather than an empty screen.
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || run || !runs.data) return;
    adopted.current = true;
    const active = runs.data.runs.find((r) => r.projectId === project.id && isLive(r));
    if (!active) return;
    setRun(active);
    setRunning(active.status === "executing");
  }, [runs.data, run, project.id]);

  // Follow the live run while it executes; the executor writes each step as it goes.
  const live = useJson<{ run: NavigatorRun }>(
    run && running ? `/api/navigator/runs/${run.id}` : null,
    800
  );
  const liveRun = live.data?.run;
  const shown = (running && liveRun && liveRun.id === run?.id && liveRun) || run;
  const presentation = gimbalPresentationFor({ planning, running, cancelling, error, run: shown });
  const gimbalState = presentation.state;

  useEffect(() => {
    try {
      setCharacterVisible(localStorage.getItem("orrery-gimbal-visible") !== "false");
    } catch {
      // Storage may be unavailable; visible is the safe, reversible default.
    }
  }, []);

  const toggleCharacter = useCallback(() => {
    setCharacterVisible((visible) => {
      const next = !visible;
      try {
        localStorage.setItem("orrery-gimbal-visible", String(next));
      } catch {
        // The preference is optional; the control still works for this session.
      }
      return next;
    });
  }, []);

  // An adopted run finishes on the server, not in this tab's `execute` call.
  useEffect(() => {
    const followed = live.data?.run;
    if (running && followed && followed.id === run?.id && followed.status !== "executing") {
      setRun(followed);
      setRunning(false);
    }
  }, [live.data, running, run?.id]);

  const prodEnvIds = useMemo(
    () => new Set(environments.filter((e) => e.class === "production").map((e) => e.id)),
    [environments]
  );

  const plan = useCallback(async () => {
    if (!goal.trim()) return;
    setPlanning(true);
    setError(undefined);
    try {
      const res = await createRunAction(project.id, goal);
      if (res.error || !res.run) {
        setError(`${res.error ?? "The Navigator could not plan that."} ${res.fix ?? ""}`.trim());
        return;
      }
      setRun(res.run);
      setParsing(res.parsing);
      setApprovals(new Set());
      runs.refresh();
    } catch {
      setError("Navigator could not reach the planner. Check your connection, then try planning again.");
    } finally {
      setPlanning(false);
    }
  }, [project.id, goal, runs]);

  const execute = useCallback(async () => {
    if (!run) return;
    setRunning(true);
    setError(undefined);
    try {
      const res = await executeRunAction(run.id, [...approvals]);
      if (res.error || !res.run) {
        setError(`${res.error ?? "The run could not be executed."} ${res.fix ?? ""}`.trim());
        return;
      }
      setRun(res.run);
      runs.refresh();
      refresh(); // costs, findings and deployments all move when a run lands
    } catch {
      setError("The connection to this run was interrupted. Inspect its recorded status before retrying; actions may still be running.");
    } finally {
      setRunning(false);
    }
  }, [run, approvals, runs, refresh]);

  // Cancelling is its own request: `execute` is still awaiting the executor in
  // this tab, and the executor sees the new status between steps.
  const cancel = useCallback(async () => {
    if (!shown) return;
    setCancelling(true);
    setError(undefined);
    try {
      const res = await cancelRunAction(shown.id);
      if (res.error || !res.run) {
        setError(`${res.error ?? "The run could not be cancelled."} ${res.fix ?? ""}`.trim());
        return;
      }
      // A run that was only awaiting approval is finished now; one mid-flight is
      // still writing its last step, and the poll above picks that up.
      if (res.run.status !== "executing") setRun(res.run);
      runs.refresh();
    } catch {
      setError("Cancellation could not be confirmed. Check the recorded run status before trying again.");
    } finally {
      setCancelling(false);
    }
  }, [shown, runs]);

  const toggleApprove = useCallback((stepId: string, on: boolean) => {
    setApprovals((prev) => {
      const next = new Set(prev);
      if (on) next.add(stepId);
      else next.delete(stepId);
      return next;
    });
  }, []);

  return (
    <div className={styles.workspace}>
      <header className={styles.pageHeader}>
        <div>
          <h1 className="app-page-title">Navigator</h1>
          <p className="mt-2 text-[13px] text-ink-mute">Describe the change. Review its scope. Approve the next step.</p>
        </div>
        <div role="status" aria-live="polite" aria-atomic="true">
          <GimbalStatus state={presentation.state} label={presentation.label} />
        </div>
      </header>
      <div className={styles.layout}>
        <div className={styles.task}>
          <CommandBar value={goal} onChange={setGoal} onSubmit={plan} busy={planning}
            gimbalState={gimbalState} disabledReason={planBlock(autonomy)} showExamples={!shown} />
          {error && <Callout tone="err" compact>{error}</Callout>}
          {live.error && running && (
            <Callout tone="warn" compact>
              Live updates are interrupted. The last recorded state remains below; execution may continue.
              <button type="button" onClick={live.refresh} className="ml-2 underline">Refresh run status</button>
            </Callout>
          )}
          {shown && parsing && <ParsingNote parsing={parsing} />}
          {shown && (
            <RunPanel run={shown} projectId={project.id} slug={slug} autonomy={autonomy}
              approvals={approvals} onToggleApprove={toggleApprove} onRun={execute} running={running}
              onCancel={cancel} cancelling={cancelling} role={role} onSuggest={setGoal} prodEnvIds={prodEnvIds} />
          )}
          {!shown && !planning && (
            <div className={styles.emptyWorkflow}>
              <NavigatorGlyph size={24} className="text-nav-accent" />
              <div><h2 className="app-section-title">A plan before every change</h2>
                <p className="mt-1 max-w-[60ch] text-[13px] text-ink-mute">Your request becomes a sequence of registered actions, with scope, risk and approval visible before execution.</p>
              </div>
            </div>
          )}
          <section className={styles.history} aria-labelledby="navigator-history-title">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="navigator-history-title" className="app-section-title">Run history</h2>
              <span className="text-[12px] text-ink-faint">Recorded for this project</span>
            </div>
            {runs.error ? <Callout tone="err" compact>Run history is unavailable. <button type="button" onClick={runs.refresh} className="underline">Try again</button></Callout> :
              <RunHistory runs={runs.data?.runs} deployments={deployments} loading={runs.loading} activeRunId={shown?.id} />}
          </section>
        </div>
        <aside className={styles.context} aria-label="Navigator context">
          <Header autonomy={autonomy} onAutonomyChanged={shell.refresh} loading={shell.loading && !shell.boot}
            plannerMode={plannerMode} model={plannerModel} workspaceName={shell.boot?.workspace.name}
            role={role} presentation={presentation}
            characterVisible={characterVisible} onToggleCharacter={toggleCharacter} />
          <Advisories findings={findings} deployments={deployments} environments={environments}
            slug={slug} onSuggest={setGoal} />
        </aside>
      </div>
    </div>
  );
}

/* --------------------------------- header --------------------------------- */

/**
 * What actually read this goal. The header says what the Navigator *can* do;
 * this says what it *did* — a deterministic fallback never gets to wear the
 * model's name.
 */
function ParsingNote({ parsing }: { parsing: Parsing }) {
  if (parsing.usedLlm)
    return (
      <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-mute">
        <Chip tone="nav" className="font-mono">
          {parsing.model}
        </Chip>
        translated this goal into the typed grammar below. The deterministic planner still chose
        every action, risk and approval.
      </p>
    );
  return (
    <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-mute">
      <Chip tone="neutral">deterministic parser</Chip>
      {parsing.fallbackReason ?? "This goal was read by pattern matching — no model was involved."}
    </p>
  );
}

function Header({
  autonomy,
  onAutonomyChanged,
  loading,
  plannerMode,
  model,
  workspaceName,
  role,
  presentation,
  characterVisible,
  onToggleCharacter,
}: {
  autonomy: AutonomyLevel;
  onAutonomyChanged: () => void;
  loading: boolean;
  plannerMode: PlannerModeProp;
  /** the model configured to translate goals, once the server has named it */
  model?: string;
  workspaceName?: string;
  role: WorkspaceRole | null;
  presentation: GimbalPresentation;
  characterVisible: boolean;
  onToggleCharacter: () => void;
}) {
  const { state } = presentation;
  return (
    <div className={styles.support}>
      <div className={styles.companion}>
        {characterVisible && <figure className={styles.figure} data-gimbal-state={state ?? "neutral"}>
          <GimbalCharacter state={state} material="porcelain" />
        </figure>}
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-ink">Gimbal</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-mute">{presentation.description}</p>
        </div>
      </div>
      <details className={styles.disclosure}>
        <summary>Autonomy <Chip tone="nav">{autonomy}</Chip></summary>
        <div className="pt-3">{loading ? <Skeleton height={28} width="100%" /> :
          <AutonomyDial level={autonomy} onChanged={onAutonomyChanged} workspaceName={workspaceName} role={role} />}</div>
      </details>
      <details className={styles.disclosure}>
        <summary>Companion &amp; planning</summary>
        <div className="space-y-4 pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={onToggleCharacter} aria-pressed={characterVisible}
              className="inline-flex min-h-9 items-center gap-1.5 text-[12px] text-ink-mute hover:text-ink">
              {characterVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {characterVisible ? "Hide Gimbal" : "Show Gimbal"}
            </button>
          </div>
          <p className="text-[12px] leading-relaxed text-ink-mute">{PLANNER_NOTES[plannerMode]}{plannerMode === "llm" && model ? ` Model: ${model}.` : ""}</p>
          <GimbalStateGuide current={state} />
        </div>
      </details>
    </div>
  );
}

function GimbalStateGuide({ current }: { current: GimbalState | null }) {
  return (
    <aside className="gimbal-state-guide" aria-label="Gimbal state guide">
      <p className="mb-2 text-[12px] font-medium text-ink-mute">A clear signal at every step</p>
      <ul className="space-y-1">
        {GIMBAL_STATES.map((state) => (
          <li key={state} className={cx("gimbal-guide-row", state === current && "gimbal-guide-current")}>
            <GimbalStatus state={state} />
            {state === current && <span className="sr-only">current</span>}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">You set the course. Every action is audited.</p>
    </aside>
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
    <div className="grid gap-3">
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
        "border-t bg-bg2 px-4 py-3",
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
