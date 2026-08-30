"use client";
/**
 * Small pieces every screen in workstream E2 shares: the action runner that
 * turns an ApiError into a toast that names its fix, the plan-first confirm
 * dialog, and a couple of one-liner presenters.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { ActionPlan, ActionResult } from "@/lib/actions/core";
import { ApiError, executeAction, planAction } from "@/lib/client/api";
import type { Actor, ChangeItem, EnvironmentClass } from "@/lib/domain/types";
import { cx, fmtUsd } from "@/lib/format";
import {
  Button,
  Chip,
  CostDelta,
  Dialog,
  Input,
  RiskBadge,
  Skeleton,
  useToasts,
  type ChipTone,
  type ToastApi,
} from "@/components/ui";

const NOOP_TOASTS: ToastApi = {
  toasts: [],
  push: () => "",
  dismiss: () => {},
};

/**
 * `useToasts()` throws without a provider. Screens render inside another
 * workstream's layout, so a missing provider must degrade to silence, never to
 * a white screen.
 */
export function useSafeToasts(): ToastApi {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useToasts();
  } catch {
    return NOOP_TOASTS;
  }
}

export interface Scope {
  projectId?: string;
  environmentId?: string;
}

/** Human sentence for anything thrown by the client spine. */
export function errorText(e: unknown): { message: string; fix?: string } {
  if (e instanceof ApiError) return { message: e.message, fix: e.fix };
  if (e instanceof Error) return { message: e.message };
  return { message: "Something went wrong.", fix: "Reload the page and try again." };
}

/**
 * Execute an action, toast the outcome, hand back the result.
 * Returns `undefined` when the call failed, so callers can `if (!r) return`.
 */
export function useRunAction(onSettled?: () => void) {
  const toasts = useSafeToasts();
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = useCallback(
    async (
      actionId: string,
      call: { input?: unknown; scope?: Scope },
      opts: { busyKey?: string; silent?: boolean } = {}
    ): Promise<ActionResult | undefined> => {
      setBusyId(opts.busyKey ?? actionId);
      try {
        const result = await executeAction(actionId, call);
        if (!result.ok) {
          toasts.push({
            kind: "err",
            title: result.summary,
            body: result.error ?? "The action did not complete.",
          });
        } else if (!opts.silent) {
          toasts.push({ kind: "ok", title: result.summary });
        }
        onSettled?.();
        return result.ok ? result : undefined;
      } catch (e) {
        const { message, fix } = errorText(e);
        toasts.push({ kind: "err", title: message, body: fix });
        return undefined;
      } finally {
        setBusyId(null);
      }
    },
    [toasts, onSettled]
  );

  return { run, busyId, busy: busyId !== null };
}

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
    <div
      className={cx(
        "flex gap-2.5 rounded-card border border-err/30 bg-err-dim px-4 py-3 text-[13px]",
        className
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-err" />
      <div className="min-w-0">
        <p className="text-ink">{message}</p>
        {fix && <p className="mt-1 text-ink-mute">{fix}</p>}
      </div>
    </div>
  );
}

/* ------------------------------ plan preview ------------------------------ */

export function PlanBody({ plan }: { plan: ActionPlan }) {
  return (
    <div className="space-y-4">
      <p className="text-[14px] text-ink">{plan.summary}</p>

      <div className="flex flex-wrap items-center gap-2">
        <RiskBadge level={plan.risk} />
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
        <ul className="space-y-1.5 rounded-card border border-warn/30 bg-warn-dim px-4 py-3 text-[13px] text-ink">
          {plan.warnings.map((w, i) => (
            <li key={i} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
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

  const confirmBlocked = typeToConfirm ? typed.trim() !== typeToConfirm : false;

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
            disabled={!plan || confirmBlocked}
            disabledReason={
              !plan
                ? "Waiting for the plan — the preview has to load before anything runs."
                : confirmBlocked
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
        {typeToConfirm && plan ? (
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

/* ------------------------------- presenters ------------------------------- */

const ENV_TONE: Record<EnvironmentClass, ChipTone> = {
  sandbox: "info",
  staging: "signal",
  production: "prod",
};

export const envTone = (klass: EnvironmentClass): ChipTone => ENV_TONE[klass];

/** class-coloured dot used on environment chips across overview + settings. */
export function EnvDot({ klass }: { klass: EnvironmentClass }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        klass === "production" ? "bg-prod" : klass === "staging" ? "bg-signal" : "bg-info"
      )}
    />
  );
}

/** Agent work is always visibly agent work. */
export function ActorDot({ actor }: { actor: Actor }) {
  const tone =
    actor.type === "navigator" ? "bg-nav-accent" : actor.type === "user" ? "bg-signal" : "bg-ink-faint";
  return (
    <span
      title={`${actor.name} (${actor.type})`}
      className={cx("inline-block h-2 w-2 shrink-0 rounded-full", tone)}
    />
  );
}

const OP_TONE: Record<ChangeItem["op"], ChipTone> = {
  create: "ok",
  update: "info",
  delete: "err",
};

const OP_LABEL: Record<ChangeItem["op"], string> = {
  create: "add",
  update: "change",
  delete: "remove",
};

/** One line of a changeset — same explanation strings everywhere. */
export function ChangeRow({ item }: { item: ChangeItem }) {
  return (
    <li className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <Chip tone={OP_TONE[item.op]} className="mt-0.5">
        {OP_LABEL[item.op]}
      </Chip>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-ink">
          <span className="font-mono">{item.nodeName}</span>{" "}
          <span className="text-ink-faint">{item.nodeType}</span>
        </p>
        <p className="mt-0.5 text-[12.5px] text-ink-mute">{item.explanation}</p>
        {item.fields && item.fields.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 font-mono text-[11.5px] text-ink-faint">
            {item.fields.map((f) => (
              <li key={f.field}>
                {f.field}: {JSON.stringify(f.before)} → {JSON.stringify(f.after)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {item.costDeltaUsd !== 0 && <CostDelta usd={item.costDeltaUsd} />}
        <RiskBadge level={item.risk} />
      </div>
    </li>
  );
}

/** "$120.00" with tabular figures, used wherever a monthly estimate appears. */
export function Money({ usd, className }: { usd: number; className?: string }) {
  return <span className={cx("tnum", className)}>{fmtUsd(usd)}</span>;
}
