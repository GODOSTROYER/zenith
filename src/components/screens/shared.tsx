"use client";
/**
 * Small pieces every screen in workstream E2 shares: the action runner that
 * turns an ApiError into a toast that names its fix, the plan-first confirm
 * dialog, and a couple of one-liner presenters.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Ban } from "lucide-react";
import type { ActionPlan, ActionResult, Role } from "@/lib/actions/core";
import { ApiError, executeAction, planAction } from "@/lib/client/api";
import type { Actor, ChangeItem, EnvironmentClass } from "@/lib/domain/types";
import { cx } from "@/lib/format";
import { useShell } from "@/components/shell/shell-context";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { CostDelta } from "@/components/ui/cost-delta";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RiskBadge } from "@/components/ui/risk-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToasts } from "@/components/ui/toast";

/**
 * Kept as a name because screens import it. `useToasts()` itself now degrades
 * to a no-op outside a provider (see components/ui/toast.tsx), so this is a
 * plain hook call — no try/catch, no conditional hook, no "rendered fewer
 * hooks than expected" when a provider unmounts mid-tree.
 */
export const useSafeToasts = useToasts;

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
    <Callout tone="err" className={className}>
      <p className="text-ink">{message}</p>
      {fix && <p className="mt-1 text-ink-mute">{fix}</p>}
    </Callout>
  );
}

/* ------------------------------ plan preview ------------------------------ */

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/**
 * One sentence when the caller's workspace role is below the role the plan says
 * execute demands — so the preview says it before the button is pressed, even
 * when the server did not set `blocked` (a plan blocked for some other reason
 * first, or one planned on someone else's behalf).
 *
 * `null` caller role means "not signed in / demo mode": nothing to compare.
 */
export function roleShortfall(
  required: Role | undefined,
  caller: Role | null | undefined
): string | undefined {
  if (!required || !caller) return undefined;
  if (ROLE_RANK[caller] >= ROLE_RANK[required]) return undefined;
  return (
    `This needs the ${required} role and you are ${caller} in this workspace. ` +
    `Ask a workspace admin to raise your role in Settings → Members, or have them run it.`
  );
}

/**
 * "needs editor" — the role an action demands, toned red when the caller does
 * not have it. Both plan previews (this file's dialog and the inspector's
 * inline PlanFirst) show the same chip with the same tooltip.
 */
export function RoleChip({ required, shortfall }: { required: Role; shortfall?: string }) {
  return (
    <Chip
      tone={shortfall ? "err" : "neutral"}
      title={shortfall ?? `Running this needs the ${required} role.`}
    >
      needs {required}
    </Chip>
  );
}

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

/* ------------------------------- presenters ------------------------------- */

/**
 * The label above a group of fields inside a panel — inspector tabs, the
 * deploy dock, the changes review. One markup, so a section heading never
 * drifts a pixel between two panels that sit side by side.
 */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[13px] font-semibold leading-snug text-ink-mute">
      {children}
    </h3>
  );
}

/**
 * "This number was computed, not measured." One label for every surface that
 * shows generated health, generated logs or an estimated cost, so the claim
 * reads the same wherever it appears. `title` says what was simulated when the
 * surface can be specific about it.
 */
export function SimulatedChip({ title }: { title?: string }) {
  return (
    <Chip tone="info" title={title}>
      simulated
    </Chip>
  );
}

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
  create: "signal",
  update: "signal",
  delete: "err",
};

const OP_LABEL: Record<ChangeItem["op"], string> = {
  create: "add",
  update: "change",
  delete: "remove",
};

/** One line of a changeset — same explanation strings everywhere. */
export function ChangeRow({ item, onSelect, selected = false }: { item: ChangeItem; onSelect?: () => void; selected?: boolean }) {
  return (
    <li className={cx("flex flex-wrap items-start gap-3 border-b border-line px-4 py-3 last:border-b-0 transition-colors duration-[var(--dur-fast)]", selected && "bg-signal-dim")}>
      <Chip tone={OP_TONE[item.op]} className="mt-0.5">
        {OP_LABEL[item.op]}
      </Chip>
      <div className="min-w-[140px] flex-1">
        <p className="text-[13px] text-ink">
          {onSelect ? <button type="button" onClick={onSelect} aria-pressed={selected} aria-label={`Inspect ${item.nodeName}`} className="break-all text-left font-mono underline decoration-line-strong underline-offset-4 hover:text-signal">{item.nodeName}</button> : <span className="break-all font-mono">{item.nodeName}</span>}{" "}
          <span className="text-ink-faint">{item.nodeType}</span>
        </p>
        <p className="mt-0.5 text-[12.5px] text-ink-mute">{item.explanation}</p>
        {item.fields && item.fields.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 font-mono text-[11.5px] text-ink-faint">
            {item.fields.map((f) => (
              <li key={f.field} className="break-all">
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
