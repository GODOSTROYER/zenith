"use client";
import { useEffect, useState } from "react";
import { AlertTriangle, Rocket, ShieldAlert } from "lucide-react";
import { Button, CostDelta, Input, RiskBadge, useToasts } from "@/components/ui";
import { useProjectData } from "@/components/shell/project-context";
import { ApiError, executeAction, planAction } from "@/lib/client/api";
import type { ActionPlan } from "@/lib/actions/core";
import { cx, fmtUsd } from "@/lib/format";
import type { ChangeItem, Changeset } from "@/lib/domain/types";

const GROUPS: { op: ChangeItem["op"]; label: string }[] = [
  { op: "create", label: "Added" },
  { op: "update", label: "Changed" },
  { op: "delete", label: "Removed" },
];

function ItemRow({ item }: { item: ChangeItem }) {
  return (
    <li className="flex items-start gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink">{item.nodeName}</span>
          <span className="shrink-0 text-[11.5px] text-ink-faint">{item.nodeType}</span>
        </div>
        <p className="mt-0.5 text-[12.5px] text-ink-mute">{item.explanation}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <CostDelta usd={item.costDeltaUsd} />
        <RiskBadge level={item.risk} />
      </div>
    </li>
  );
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
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null);

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

  const blocking = workingIssues.filter((i) => i.level === "error");
  const warnings = (plan?.warnings ?? changeset.warnings).filter(
    (w) => !w.startsWith("Blocks the deploy:")
  );
  const needsApproval = selectedEnv?.policies.approvalRequired ?? false;
  const isProd = selectedEnv?.class === "production";

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
        <h2 className="text-[16px] font-medium text-ink">
          {changeset.items.length} pending change{changeset.items.length === 1 ? "" : "s"} for{" "}
          {selectedEnv?.name ?? "this environment"}
        </h2>
        <span className="tnum font-mono text-[12.5px] text-ink-mute">
          {fmtUsd(changeset.projectedMonthlyUsd)}
          <span className="text-ink-faint">/mo est. after deploy</span>{" "}
          <CostDelta usd={changeset.totalCostDeltaUsd} />
        </span>
      </div>

      {blocking.length > 0 && (
        <div className="space-y-2 rounded-card border border-err/30 bg-err-dim p-3">
          <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <ShieldAlert className="h-4 w-4 text-err" aria-hidden="true" />
            {blocking.length} problem{blocking.length === 1 ? "" : "s"} to fix before this can deploy
          </p>
          <ul className="space-y-1.5">
            {blocking.map((i, n) => (
              <li key={n} className="text-[12.5px] text-ink">
                {i.message}
                {i.fix && <span className="text-ink-mute"> {i.fix}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="space-y-1.5 rounded-card border border-warn/25 bg-warn-dim p-3">
          {warnings.map((w, n) => (
            <p key={n} className="flex gap-2 text-[12.5px] text-ink">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
              <span>{w}</span>
            </p>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {GROUPS.map(({ op, label }) => {
          const items = changeset.items.filter((i) => i.op === op);
          if (items.length === 0) return null;
          return (
            <div key={op} className="space-y-1.5">
              <h3 className="text-[12px] font-medium tracking-[0.04em] text-ink-faint uppercase">
                {label} · {items.length}
              </h3>
              <ul className="overflow-hidden rounded-card border border-line bg-bg1">
                {items.map((i) => (
                  <ItemRow key={`${i.op}-${i.nodeId}`} item={i} />
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="space-y-1 rounded-card border border-err/30 bg-err-dim p-3">
          <p className="text-[13px] text-ink">{error.message}</p>
          {error.fix && <p className="text-[12.5px] text-ink-mute">{error.fix}</p>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
        <div className="min-w-[220px] flex-1">
          <Input
            value={message}
            placeholder="What changed? (optional — becomes the revision message)"
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>
        <Button
          variant={isProd ? "danger" : "primary"}
          busy={busy}
          disabled={blocking.length > 0}
          disabledReason={
            blocking.length > 0
              ? "Fix the problems listed above first — each one says what to do."
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
