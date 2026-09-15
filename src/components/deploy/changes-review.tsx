"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Rocket, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { CostDelta } from "@/components/ui/cost-delta";
import { Input } from "@/components/ui/input";
import { RiskBadge } from "@/components/ui/risk-badge";
import { useToasts } from "@/components/ui/toast";
import { useProjectData } from "@/components/shell/project-context";
import { ChangeRow, SectionTitle } from "@/components/screens/shared";
import { api, ApiError, executeAction, planAction, useJson } from "@/lib/client/api";
import type { ActionPlan } from "@/lib/actions/core";
import { cx, fmtDuration, fmtUsd } from "@/lib/format";
import type { ChangeItem, Changeset, Revision } from "@/lib/domain/types";

const ChangeRehearsal = dynamic(() => import("@/components/spatial/change-rehearsal").then((m) => m.ChangeRehearsal), {
  ssr: false,
  loading: () => <p role="status" className="border border-line bg-bg1 p-4 text-[13px] text-ink-mute">Preparing the change rehearsal…</p>,
});

const GROUPS: { op: ChangeItem["op"]; label: string }[] = [
  { op: "create", label: "Added" },
  { op: "update", label: "Changed" },
  { op: "delete", label: "Removed" },
];

/** `POST /api/environments/:id/plan-steps` — the steps a deploy would run. */
interface StepPlan {
  phases: { name: string; steps: { title: string; estMs: number }[] }[];
  /** true when the provider is the sandbox and none of this touches a real cloud */
  simulated: boolean;
  provider: string;
  /** present instead of `phases` when this provider cannot plan */
  blocked?: string;
}


/** djb2 — enough to key a changeset, not a security hash. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export interface ChangesReviewProps {
  changeset: Changeset;
  onDeployed: (deploymentId: string) => void;
}

/**
 * Everything that will change, why, and what it costs — before anything runs.
 * Blocking problems disable the deploy and say exactly how to clear them.
 */
export function ChangesReview({ changeset, onDeployed }: ChangesReviewProps) {
  const { project, selectedEnv, selectedEnvId, workingIssues, refresh } = useProjectData();
  const toasts = useToasts();
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [typed, setTyped] = useState("");
  const [steps, setSteps] = useState<StepPlan>();
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: current, error: currentError, refresh: retryCurrent } = useJson<{ revision: Revision }>(
    selectedEnv?.deployedRevisionId ? `/api/revisions/${selectedEnv.deployedRevisionId}` : null
  );
  const currentManifest = current && current.revision.id === selectedEnv?.deployedRevisionId ? current.revision.manifest : null;

  const scope = { projectId: project.id, environmentId: selectedEnvId };

  // The whole changeset, not its length: an edit that changes cost without
  // changing the count must not leave a stale budget/warning banner on screen.
  const changesetKey = JSON.stringify(changeset);

  useEffect(() => {
    let alive = true;
    planAction("deploy.plan", { scope })
      .then((p) => alive && setPlan(p))
      .catch(() => alive && setPlan(null));
    return () => {
      alive = false;
    };
    // scope is derived from these two; changesetKey is the re-plan trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, selectedEnvId, changesetKey]);

  // The would-be deployment's steps, from the provider's own planner. Keyed on
  // the changeset's hash, not on the changeset: this is a POST, and re-posting
  // it on every keystroke in the message field would be a request per letter.
  const changesetHash = hash(changesetKey);
  useEffect(() => {
    if (!selectedEnvId) return;
    let alive = true;
    setSteps(undefined);
    api<StepPlan>(`/api/environments/${selectedEnvId}/plan-steps`, {
      method: "POST",
      body: JSON.stringify({ revisionSource: "working" }),
    })
      .then((s) => alive && setSteps(s))
      // A preview that cannot be fetched is not worth a banner — the deploy
      // path is unaffected, and the blocking reasons above already speak.
      .catch(() => alive && setSteps(undefined));
    return () => {
      alive = false;
    };
  }, [selectedEnvId, changesetHash]);

  // One authority for "this would be refused": the server's own plan, which
  // already folds in the provider, the connection, the caller's role and the
  // manifest's own errors. Until it arrives, the locally computed errors stand
  // in, so a broken working copy never renders an enabled Deploy button.
  const blocking = plan
    ? plan.blocked
      ? [plan.blocked]
      : []
    : workingIssues
        .filter((i) => i.level === "error")
        .map((i) => `${i.message}${i.fix ? ` ${i.fix}` : ""}`);
  const warnings = plan?.warnings ?? changeset.warnings;
  const needsApproval = plan?.requiresApproval ?? selectedEnv?.policies.approvalRequired ?? false;
  const isProd = selectedEnv?.class === "production";
  const envName = selectedEnv?.name ?? "";
  // Production is typed out in full, exactly like a production delete.
  const needsTyped = isProd && typed.trim() !== envName;

  const deploy = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await executeAction("deploy.apply", {
        input: message.trim() ? { message: message.trim() } : {},
        scope,
        // Keyed on what is being deployed, not on when the button was hit:
        // two clicks on the same changeset are the same deployment. `attempt`
        // only moves after a visible failure, so a retry is a real retry.
        idempotencyKey: `deploy-${selectedEnvId}-${hash(`${changesetKey}|${message.trim()}`)}-${attempt}`,
      });
      if (!result.ok) {
        setError({ message: result.summary, fix: result.error });
        setAttempt((n) => n + 1);
        return;
      }
      const id = (result.data as { deploymentId?: string } | undefined)?.deploymentId;
      toasts.push({ title: result.summary, kind: "ok" });
      refresh();
      if (id) onDeployed(id);
    } catch (err) {
      setAttempt((n) => n + 1);
      const e = err instanceof ApiError ? err : undefined;
      setError({
        message: e?.message ?? "The deploy could not be started.",
        fix: e?.fix ?? "Check the environment's connection on the Settings tab, then try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[20px] font-semibold text-ink">
          {changeset.items.length} pending change{changeset.items.length === 1 ? "" : "s"} for{" "}
          {selectedEnv?.name ?? "this environment"}
        </h2>
        <span className="tnum font-mono text-[12.5px] text-ink-mute">
          {fmtUsd(changeset.projectedMonthlyUsd)}
          <span className="text-ink-faint">/mo est. after deploy</span>{" "}
          <CostDelta usd={changeset.totalCostDeltaUsd} />
        </span>
      </div>
      <p className="text-[13px] text-ink-mute">Rehearse the working configuration against {selectedEnv?.deployedRevisionId ? "the revision deployed here" : "this environment’s first deployment"}. Review each affected resource before anything runs.</p>
      {isProd && <Chip tone="prod">Production · {envName}</Chip>}

      {/* The plan the server just produced for this exact changeset. */}
      {plan && (
        <div className="flex flex-wrap items-center gap-2">
          <RiskBadge level={plan.risk} />
          <Chip
            tone={plan.costDeltaUsd === 0 ? "neutral" : plan.costDeltaUsd > 0 ? "warn" : "ok"}
            title="Estimated change to the monthly bill if this deploy succeeds."
          >
            <CostDelta usd={plan.costDeltaUsd} bare /> est./mo
          </Chip>
          {plan.requiresApproval && (
            <Chip
              tone="prod"
              title={`${envName || "This environment"} requires a human to approve before anything is applied.`}
            >
              Approval required
            </Chip>
          )}
        </div>
      )}

      {blocking.length > 0 && (
        <Callout
          tone="err"
          icon={<ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-err" aria-hidden="true" />}
          title={
            plan?.blocked
              ? "This deploy would be refused"
              : `${blocking.length} problem${blocking.length === 1 ? "" : "s"} to fix before this can deploy`
          }
        >
          <ul className="space-y-1.5">
            {blocking.map((b) => (
              <li key={b} className="text-[12.5px] text-ink">
                {b}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {warnings.length > 0 && (
        <Callout tone="warn">
          <ul className="space-y-1.5">
            {warnings.map((w, n) => (
              <li key={n} className="text-[12.5px] text-ink">
                {w}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {selectedEnv?.deployedRevisionId && !currentManifest ? (
        <div role="status" className="border border-line bg-bg1 p-4 text-[13px] text-ink-mute">
          {currentError ? <><p>The deployed configuration could not be loaded. The change list remains available below.</p><Button variant="quiet" size="sm" onClick={retryCurrent} className="mt-2">Retry comparison</Button></> : "Loading the deployed configuration for an exact comparison…"}
        </div>
      ) : <ChangeRehearsal currentManifest={currentManifest} proposedManifest={project.workingManifest} changeset={changeset} selectedId={selectedId} onSelect={setSelectedId} environmentName={envName || "This environment"} />}

      <div className="space-y-3">
        {GROUPS.map(({ op, label }) => {
          const items = changeset.items.filter((i) => i.op === op);
          if (items.length === 0) return null;
          return (
            <div key={op} className="space-y-1.5">
              <SectionTitle>
                {label} · {items.length}
              </SectionTitle>
              {/* Same row component as the revision diff: one explanation,
                  one field list, wherever a change is read. */}
              <ul className="overflow-hidden rounded-card border border-line bg-bg1">
                {items.map((i) => (
                  <ChangeRow key={`${i.op}-${i.nodeId}`} item={i} selected={selectedId === i.nodeId} onSelect={() => setSelectedId(i.nodeId)} />
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <StepPreview plan={steps} />

      {error && (
        <Callout tone="err">
          <p className="text-[13px] text-ink">{error.message}</p>
          {error.fix && <p className="mt-1 text-[12.5px] text-ink-mute">{error.fix}</p>}
        </Callout>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
        <div className="min-w-[220px] flex-1">
          <Input
            value={message}
            aria-label="Revision message"
            placeholder="What changed? (optional — becomes the revision message)"
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>
        {isProd && (
          <label className="flex min-w-[220px] flex-1 items-center gap-2">
            <span className="shrink-0 text-[12px] text-ink-mute">
              Type <span className="font-mono text-ink">{envName}</span>
            </span>
            <Input
              mono
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={envName}
              autoComplete="off"
              aria-label={`Type ${envName} to confirm deploying to production`}
            />
          </label>
        )}
        <Button
          variant={isProd ? "danger" : "primary"}
          busy={busy}
          disabled={blocking.length > 0 || needsTyped}
          disabledReason={
            blocking.length > 0
              ? (plan?.blocked ?? "Fix the problems listed above first — each one says what to do.")
              : needsTyped
                ? `Type “${envName}” to confirm — this changes production.`
                : undefined
          }
          icon={<Rocket className="h-3.5 w-3.5" aria-hidden="true" />}
          onClick={deploy}
          className={cx(isProd && "ring-1 ring-prod/45")}
        >
          {needsApproval
            ? `Request approval for ${selectedEnv?.name ?? "this environment"}`
            : `Deploy to ${selectedEnv?.name ?? "this environment"}`}
        </Button>
      </div>
    </div>
  );
}

/**
 * What the deploy would actually do, phase by phase, before it does it.
 *
 * The same steps the deployment timeline will show once this is running — they
 * come from the same `provider.planSteps` the engine calls — so the review and
 * the deploy tell one story. Deliberately no progress bars: nothing has run,
 * and an empty bar per phase would be four pieces of furniture saying nothing.
 *
 * Every number here is an estimate and says so once, at the top. A provider
 * that cannot plan says that instead, in its own words.
 */
function StepPreview({ plan }: { plan: StepPlan | undefined }) {
  if (!plan) return null;

  if (plan.blocked)
    return (
      <p className="border-t border-line pt-3 text-[12.5px] text-ink-mute">{plan.blocked}</p>
    );

  const total = plan.phases.reduce(
    (sum, p) => sum + p.steps.reduce((n, s) => n + s.estMs, 0),
    0
  );
  const count = plan.phases.reduce((n, p) => n + p.steps.length, 0);
  if (count === 0) return null;

  return (
    <section className="space-y-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>
          What this deploy would do · {count} step{count === 1 ? "" : "s"}
        </SectionTitle>
        <span className="flex items-center gap-2 text-[11.5px] text-ink-faint">
          {plan.simulated && (
            <Chip title="The sandbox provider runs these steps in this process. Nothing reaches a real cloud and the addresses it hands back are local.">
              simulated
            </Chip>
          )}
          <span title="Estimated by the provider from the plan. Real durations are recorded per step while the deploy runs.">
            about <span className="tnum font-mono text-ink-mute">{fmtDuration(total)}</span>, estimated
          </span>
        </span>
      </div>

      <div className="space-y-3">
        {plan.phases.map((phase) => (
          <div key={phase.name} className="space-y-1">
            <div className="text-[11px] font-medium tracking-[0.06em] text-ink-faint uppercase">
              {phase.name}
            </div>
            <ul className="space-y-0.5">
              {phase.steps.map((s, i) => (
                <li
                  key={`${phase.name}-${i}-${s.title}`}
                  className="flex items-center gap-2.5 px-2 py-1"
                >
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-bg3 ring-1 ring-line"
                  />
                  <span className="min-w-0 flex-1 break-words text-[13px] text-ink-mute">
                    {s.title}
                  </span>
                  <span className="tnum shrink-0 font-mono text-[11.5px] text-ink-faint">
                    ~{fmtDuration(s.estMs)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
