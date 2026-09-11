"use client";
/**
 * Plan-first confirm: the dialog that fetches an ActionPlan, shows what will
 * happen and what it costs, and only then offers the button that does it.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Ban } from "lucide-react";
import type { ActionPlan, ActionResult } from "@/lib/actions/core";
import { ApiError, executeAction, planAction } from "@/lib/client/api";
import { useShell } from "@/components/shell/shell-context";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { CostDelta } from "@/components/ui/cost-delta";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RiskBadge } from "@/components/ui/risk-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { RoleChip, roleShortfall } from "@/components/screens/role-chip";
import { errorText, useSafeToasts, type Scope } from "@/components/screens/use-run-action";

/* ----------------------------- error surfaces ----------------------------- */

export function ErrorNote({
  error,
  className,
}: {
  error: unknown;
  className?: string;
}) {
  const { message, fix } = errorText(error);
  return (
    <Callout tone="err" className={className}>
      <p className="text-ink">{message}</p>
      {fix && <p className="mt-1 text-ink-mute">{fix}</p>}
    </Callout>
  );
}

/* ------------------------------ plan preview ------------------------------ */

/** The refusal, in the same shape everywhere: red, first, and never a warning. */
function BlockedNote({ children }: { children: ReactNode }) {
  return (
    <Callout tone="err" icon={<Ban className="mt-0.5 h-4 w-4 shrink-0 text-err" aria-hidden="true" />}>
      <p>{children}</p>
    </Callout>
  );
}

/** The plan itself, inside the confirm dialog below. Not used anywhere else. */
function PlanBody({ plan }: { plan: ActionPlan }) {
  const { boot } = useShell();
  const shortfall = roleShortfall(plan.requiredRole, boot?.role);
  return (
    <div className="space-y-4">
      <p className="text-[14px] text-ink">{plan.summary}</p>

      {/* `blocked` is the reason execute would refuse, plus the fix. It leads,
          and it is never demoted into the advisory warnings list below. */}
      {plan.blocked ? <BlockedNote>{plan.blocked}</BlockedNote> : null}
      {!plan.blocked && shortfall ? <BlockedNote>{shortfall}</BlockedNote> : null}

      <div className="flex flex-wrap items-center gap-2">
        <RiskBadge level={plan.risk} />
        {plan.requiredRole && <RoleChip required={plan.requiredRole} shortfall={shortfall} />}
        <Chip tone={plan.costDeltaUsd === 0 ? "neutral" : plan.costDeltaUsd > 0 ? "warn" : "ok"}>
          <CostDelta usd={plan.costDeltaUsd} bare /> est./mo
        </Chip>
        {plan.requiresApproval && <Chip tone="prod">Approval required</Chip>}
      </div>

      {plan.details.length > 0 && (
        <ul className="space-y-1.5 border-l border-line pl-4 text-[13px] text-ink-mute">
          {plan.details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}

      {plan.warnings.length > 0 && (
        <Callout tone="warn">
          <ul className="space-y-1.5">
            {plan.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  );
}

export interface ActionConfirmProps {
  open: boolean;
  onClose: () => void;
  actionId: string;
  input?: unknown;
  scope?: Scope;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** when set, the operator must type this exact string to enable confirm */
  typeToConfirm?: string;
  /** extra content between the description and the plan */
  children?: ReactNode;
  /**
   * Rendered under a refused plan (or a refused execute): the screen's own
   * one-click way out, e.g. reload the current copy / discard my edits. The
   * refusal already names the fix in prose; this makes it pressable.
   */
  blockedFix?: ReactNode;
  onDone?: (result: ActionResult) => void;
}

/**
 * Plan before apply: opens, fetches the ActionPlan, shows what will happen and
 * what it costs, and only then offers the button that does it.
 */
export function ActionConfirm({
  open,
  onClose,
  actionId,
  input,
  scope,
  title,
  description,
  confirmLabel,
  danger,
  typeToConfirm,
  children,
  blockedFix,
  onDone,
}: ActionConfirmProps) {
  const toasts = useSafeToasts();
  const [plan, setPlan] = useState<ActionPlan>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");

  const inputKey = JSON.stringify(input ?? {});
  const scopeKey = JSON.stringify(scope ?? {});
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPlan(undefined);
    setError(undefined);
    setTyped("");
    planAction(actionId, { input: JSON.parse(inputKey), scope: JSON.parse(scopeKey) })
      .then((p) => alive && setPlan(p))
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [open, actionId, inputKey, scopeKey]);

  const needsTyping = typeToConfirm ? typed.trim() !== typeToConfirm : false;
  /** The server already knows this input would be refused. Say so, don't offer it. */
  const blocked = plan?.blocked;
  const refused = Boolean(blocked) || error !== undefined;

  const confirm = async () => {
    setBusy(true);
    try {
      const result = await executeAction(actionId, { input, scope });
      toasts.push({
        kind: result.ok ? "ok" : "err",
        title: result.summary,
        body: result.ok ? undefined : result.error,
      });
      if (result.ok) {
        onDone?.(result);
        onClose();
      } else {
        setError(new ApiError(result.summary, 400, result.error));
      }
    } catch (e) {
      setError(e);
      const { message, fix } = errorText(e);
      toasts.push({ kind: "err", title: message, body: fix });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      tone={danger ? "danger" : "default"}
      width={520}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            busy={busy}
            disabled={!plan || Boolean(blocked) || needsTyping}
            disabledReason={
              !plan
                ? "Waiting for the plan — the preview has to load before anything runs."
                : blocked
                  ? blocked
                  : needsTyping
                    ? `Type “${typeToConfirm}” to confirm.`
                    : undefined
            }
            onClick={confirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {children}
        {error ? <ErrorNote error={error} /> : null}
        {!plan && !error ? (
          <div className="space-y-2">
            <Skeleton height={16} width="70%" />
            <Skeleton height={12} />
            <Skeleton height={12} width="85%" />
          </div>
        ) : null}
        {plan ? <PlanBody plan={plan} /> : null}
        {refused && blockedFix ? (
          <div className="flex flex-wrap items-center gap-2">{blockedFix}</div>
        ) : null}
        {/* Typing a name to confirm something that cannot run is theatre. */}
        {typeToConfirm && plan && !blocked ? (
          <label className="block space-y-1.5">
            <span className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
              Type <span className="font-mono text-ink">{typeToConfirm}</span> to confirm
            </span>
            <Input
              mono
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={typeToConfirm}
              autoComplete="off"
            />
          </label>
        ) : null}
      </div>
    </Dialog>
  );
}
