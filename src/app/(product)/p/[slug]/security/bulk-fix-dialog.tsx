"use client";
/**
 * Plan-first, N times over: every fixable finding was previewed before a
 * single one runs, and the fixes then run one at a time through the same
 * action the single-finding Fix button uses — stoppable between findings.
 */
import { useRef, useState } from "react";
import type { Role } from "@/lib/actions/core";
import { executeAction } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { CostDelta } from "@/components/ui/cost-delta";
import { Dialog } from "@/components/ui/dialog";
import { RiskBadge } from "@/components/ui/risk-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TimeAgo } from "@/components/ui/time-ago";
import {
  ErrorNote,
  errorText,
  useSafeToasts,
  type Scope,
} from "@/components/screens/shared";
import { excludedNote, type FixRow, type FixSplit } from "./rows";

export interface BulkFixDialogProps {
  /** undefined while the previews are still being computed */
  rows: FixRow[] | undefined;
  plannedAt: string | undefined;
  split: FixSplit;
  /** open findings with no automatic fix — honestly excluded, never counted in */
  skipped: number;
  role: Role | null;
  scope: Scope;
  onClose: () => void;
  onDone: () => void;
}

export function BulkFixDialog({
  rows,
  plannedAt,
  split,
  skipped,
  role,
  scope,
  onClose,
  onDone,
}: BulkFixDialogProps) {
  const toasts = useSafeToasts();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [halted, setHalted] = useState<{ ran: number; of: number }>();
  const [error, setError] = useState<unknown>();
  const stop = useRef(false);

  // The project polls while this is open, and a fix that lands changes the
  // finding list underneath it. This dialog keeps the previews it opened with,
  // so the list cannot rearrange itself mid-run and "computed before any fix
  // ran" stays literally true.
  const frozen = useRef<{ rows: FixRow[]; split: FixSplit; plannedAt?: string }>(undefined);
  if (!frozen.current && rows) frozen.current = { rows, split, plannedAt };
  const shown = frozen.current;

  const runnable = shown?.split.runnable ?? [];
  const costDelta = runnable.reduce((sum, r) => sum + (r.plan?.costDeltaUsd ?? 0), 0);
  const warnings = runnable.flatMap((r) => r.plan?.warnings ?? []);
  const excluded = shown ? excludedNote(shown.split, role) : undefined;
  const left = shown
    ? [...shown.split.roleBlocked, ...shown.split.otherBlocked, ...shown.split.unplannable]
    : [];

  const apply = async () => {
    setBusy(true);
    setError(undefined);
    setHalted(undefined);
    setStopping(false);
    stop.current = false;
    const failures: string[] = [];
    let fixed = 0;
    let ran = 0;
    try {
      for (const r of runnable) {
        if (stop.current) break;
        ran += 1;
        setProgress(ran);
        const result = await executeAction("security.resolveFinding", {
          input: { findingId: r.finding.id, applyFix: true },
          scope,
        });
        if (result.ok) fixed++;
        else failures.push(`${r.finding.title}: ${result.error ?? result.summary}`);
      }
      const stopped = ran < runnable.length;
      toasts.push({
        kind: failures.length === 0 ? "ok" : "err",
        title:
          failures.length > 0
            ? `Fixed ${fixed} of ${ran} attempted; ${failures.length} did not apply.`
            : stopped
              ? `Stopped after ${fixed} of ${runnable.length}.`
              : `Fixed ${fixed} finding${fixed === 1 ? "" : "s"}.`,
        body: failures[0],
      });
      if (failures.length > 0) setError(new Error(failures.join(" · ")));
      else if (stopped) setHalted({ ran, of: runnable.length });
      else onDone();
    } catch (e) {
      setError(e);
      const { message, fix } = errorText(e);
      toasts.push({ kind: "err", title: message, body: fix });
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Fix ${shown ? runnable.length : "…"} finding${runnable.length === 1 ? "" : "s"}`}
      description="Review the estimated impact of each fix. Changes apply one at a time and remain recorded in Activity."
      width={620}
      footer={
        <>
          {busy ? (
            <Button
              variant="quiet"
              disabled={stopping}
              disabledReason="Stopping — the fix that is running now finishes first."
              title="The fix that is running now finishes; nothing after it starts."
              onClick={() => {
                stop.current = true;
                setStopping(true);
              }}
            >
              {stopping ? "Stopping…" : "Stop after this one"}
            </Button>
          ) : (
            <Button variant="quiet" onClick={halted ? onDone : onClose}>
              {halted ? "Close" : "Cancel"}
            </Button>
          )}
          {!halted && (
            <Button
              busy={busy}
              disabled={!shown || runnable.length === 0}
              disabledReason={
                !shown
                  ? "Waiting for the previews — every fix is planned before anything runs."
                  : (excluded ?? "None of these fixes could be planned, so none of them can run.")
              }
              onClick={apply}
            >
              {busy && progress > 0
                ? `Fixing ${progress} of ${runnable.length}`
                : `Apply ${runnable.length} fix${runnable.length === 1 ? "" : "es"}`}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {error ? <ErrorNote error={error} /> : null}

        {halted && (
          <Callout tone="warn">
            Stopped after {halted.ran} of {halted.of}. The remaining {halted.of - halted.ran}{" "}
            {halted.of - halted.ran === 1 ? "fix was" : "fixes were"} not run and{" "}
            {halted.of - halted.ran === 1 ? "its finding is" : "their findings are"} still open.
          </Callout>
        )}

        {!shown ? (
          <div className="space-y-2">
            <Skeleton height={14} width="60%" />
            <Skeleton height={12} />
            <Skeleton height={12} width="80%" />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-y border-line py-4">
              <div>
                <p className="mb-1 text-[12px] text-ink-mute">Combined monthly estimate change</p>
                <CostDelta usd={costDelta} suffix="/mo est." />
              </div>
              {skipped > 0 && (
                <Chip tone="neutral">
                  {skipped} finding{skipped === 1 ? "" : "s"} with no fix left untouched
                </Chip>
              )}
            </div>

            {runnable.length > 0 && (
              <ul className="divide-y divide-line border-y border-line">
                {runnable.map((r) => (
                  <li key={r.finding.id} className="space-y-1 px-4 py-3">
                    <div className="flex items-start gap-2.5">
                      <RiskBadge level={r.plan?.risk ?? r.finding.severity} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-ink [overflow-wrap:anywhere]">{r.finding.title}</p>
                        <p className="mt-1 text-[13px] leading-relaxed text-ink-mute [overflow-wrap:anywhere]">{r.plan?.summary}</p>
                        {r.plan && r.plan.costDeltaUsd !== 0 && (
                          <p className="mt-0.5 text-[12px] text-ink-faint">
                            <CostDelta usd={r.plan.costDeltaUsd} suffix="/mo est." />
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {left.length > 0 && (
              <div className="space-y-1.5 rounded-card border border-line px-4 py-3">
                <p className="text-[12.5px] text-ink">
                  {excluded ?? `${left.length} left out.`}
                </p>
                <ul className="space-y-1 text-[12px] text-ink-mute">
                  {left.map((r) => (
                    <li key={r.finding.id}>
                      <span className="text-ink">{r.finding.title}</span> —{" "}
                      {r.plan?.blocked ?? r.error ?? "no preview came back."}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {warnings.length > 0 && (
              <Callout tone="warn">
                <ul className="space-y-1.5">
                  {[...new Set(warnings)].map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Callout>
            )}

            <p className="max-w-[70ch] text-[12px] text-ink-faint">
              Every preview above was computed{" "}
              {shown.plannedAt ? <TimeAgo iso={shown.plannedAt} /> : "when this page loaded"},
              before any fix ran. They then run one at a time, so a later fix can behave
              differently from its preview if an earlier one changed the same thing — and you can
              stop between findings. If one fails the rest still run, and the failure is named here
              and in Activity.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
