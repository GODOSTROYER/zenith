"use client";
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  Button,
  Chip,
  CostDelta,
  Field,
  Input,
  RiskBadge,
  useToasts,
  type ButtonVariant,
} from "@/components/ui";
import { useProjectData } from "@/components/shell/project-context";
import { ApiError, executeAction, planAction } from "@/lib/client/api";
import type { ActionPlan, ActionResult } from "@/lib/actions/core";
import { cx } from "@/lib/format";
import { idempotencyKey, planIsInvalid } from "./logic";

export interface PlanFirstProps {
  actionId: string;
  /** flat action input; scope is passed separately */
  input: Record<string, unknown>;
  scope?: { projectId?: string; environmentId?: string };
  label: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** required when disabled — product law: no silently dead controls */
  disabledReason?: string;
  /** when set, the exact text must be typed before the action can run */
  confirmName?: string;
  /**
   * "high-risk" asks for the typed name only when the server's own plan comes
   * back high risk — so the ceremony matches the actual consequence rather
   * than a guess made before planning.
   */
  confirmWhen?: "always" | "high-risk";
  onDone?: (result: ActionResult) => void;
  onCancel?: () => void;
  className?: string;
}

type Stage =
  | { at: "idle" }
  | { at: "planning" }
  | { at: "preview"; plan: ActionPlan }
  | { at: "running"; plan: ActionPlan }
  | { at: "error"; message: string; fix?: string };

/**
 * Plan before apply, everywhere. The preview is the real ActionPlan from the
 * server — the same object the API and the Navigator see — so what you read is
 * exactly what will run.
 */
export function PlanFirst({
  actionId,
  input,
  scope,
  label,
  variant = "primary",
  disabled = false,
  disabledReason,
  confirmName,
  confirmWhen = "always",
  onDone,
  onCancel,
  className,
}: PlanFirstProps) {
  const { project, refresh } = useProjectData();
  const toasts = useToasts();
  const [stage, setStage] = useState<Stage>({ at: "idle" });
  const [typed, setTyped] = useState("");

  const effScope = { projectId: project.id, ...scope };

  const fail = (err: unknown) => {
    const e = err instanceof ApiError ? err : undefined;
    setStage({
      at: "error",
      message: e?.message ?? (err instanceof Error ? err.message : "Something went wrong."),
      fix: e?.fix ?? "Check the values above and try again.",
    });
  };

  const startPlan = async () => {
    setStage({ at: "planning" });
    setTyped("");
    try {
      const plan = await planAction(actionId, { input, scope: effScope });
      setStage({ at: "preview", plan });
    } catch (err) {
      fail(err);
    }
  };

  const apply = async (plan: ActionPlan) => {
    setStage({ at: "running", plan });
    try {
      const result = await executeAction(actionId, {
        input,
        scope: effScope,
        // Content-keyed, like the deploy dock: a double-click or a retried
        // request replays the first result instead of applying twice. The
        // working copy is part of the key, so re-running the same edit after
        // the system moved is a new intent, not a replay.
        idempotencyKey: idempotencyKey(actionId, { input, scope: effScope }, project.workingManifest),
      });
      if (!result.ok) {
        setStage({
          at: "error",
          message: result.summary,
          fix: result.error ?? "Adjust the change and try again.",
        });
        return;
      }
      toasts.push({ title: result.summary, kind: "ok" });
      setStage({ at: "idle" });
      refresh();
      onDone?.(result);
    } catch (err) {
      fail(err);
    }
  };

  if (stage.at === "error")
    return (
      <div className={cx("space-y-2 rounded-card border border-err/30 bg-err-dim p-3", className)}>
        <p className="text-[13px] text-ink">{stage.message}</p>
        {stage.fix && <p className="text-[12.5px] text-ink-mute">{stage.fix}</p>}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="quiet" onClick={startPlan}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setStage({ at: "idle" })}>
            Dismiss
          </Button>
        </div>
      </div>
    );

  if (stage.at === "preview" || stage.at === "running") {
    const { plan } = stage;
    const running = stage.at === "running";
    // The server rejected the values before it could plan anything. There is
    // nothing to apply, so nothing offers to.
    const invalid = planIsInvalid(plan);
    const wantsTyping = Boolean(confirmName) && (confirmWhen === "always" || plan.risk === "high");
    const needsTyping = wantsTyping && typed.trim() !== confirmName;

    if (invalid)
      return (
        <div
          role="alert"
          className={cx("animate-enter space-y-2 rounded-card border border-err/30 bg-err-dim p-3", className)}
        >
          <p className="text-[13px] text-ink">These values cannot be applied.</p>
          {plan.details.map((d, i) => (
            <p key={i} className="text-[12.5px] text-ink-mute">
              {d}
            </p>
          ))}
          <Button size="sm" variant="quiet" onClick={() => setStage({ at: "idle" })}>
            Back to the form
          </Button>
        </div>
      );

    return (
      <div className={cx("animate-enter space-y-3 rounded-card border border-line bg-bg1 p-3", className)}>
        <div className="flex items-start justify-between gap-3">
          <p className="text-[13px] text-ink">{plan.summary}</p>
          <div className="flex shrink-0 items-center gap-1.5">
            {plan.requiresApproval && (
              <Chip tone="prod" title="Policy on this environment requires a human approval before it runs.">
                approval required
              </Chip>
            )}
            <RiskBadge level={plan.risk} />
          </div>
        </div>

        {plan.details.length > 0 && (
          <ul className="space-y-1 text-[12.5px] text-ink-mute">
            {plan.details.map((d, i) => (
              <li key={i} className="flex gap-1.5">
                <span aria-hidden="true" className="text-ink-faint">
                  ·
                </span>
                <span>{d}</span>
              </li>
            ))}
          </ul>
        )}

        {plan.warnings.length > 0 && (
          <div className="space-y-1 rounded-ctl border border-warn/25 bg-warn-dim p-2.5">
            {plan.warnings.map((w, i) => (
              <p key={i} className="flex gap-1.5 text-[12.5px] text-ink">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
                <span>{w}</span>
              </p>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-line pt-2.5">
          <span className="text-[12px] text-ink-faint">
            est. cost change <CostDelta usd={plan.costDeltaUsd} />
          </span>
        </div>

        {wantsTyping && (
          <Field
            label={`Type "${confirmName}" to confirm`}
            help="Destructive changes are typed out in full, on purpose."
          >
            <Input
              value={typed}
              mono
              autoFocus
              onChange={(e) => setTyped(e.target.value)}
              placeholder={confirmName}
            />
          </Field>
        )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={plan.risk === "high" ? "danger" : "primary"}
            busy={running}
            disabled={needsTyping}
            disabledReason={
              needsTyping ? `Type "${confirmName}" above to confirm this change.` : undefined
            }
            onClick={() => apply(plan)}
          >
            {plan.risk === "high" ? "Apply anyway" : "Apply"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={running}
            disabledReason={running ? "The change is being applied." : undefined}
            onClick={() => setStage({ at: "idle" })}
          >
            Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cx("flex items-center gap-2", className)}>
      <Button
        size="sm"
        variant={variant}
        busy={stage.at === "planning"}
        disabled={disabled}
        disabledReason={disabledReason}
        onClick={startPlan}
      >
        {label}
      </Button>
      {onCancel && (
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  );
}
