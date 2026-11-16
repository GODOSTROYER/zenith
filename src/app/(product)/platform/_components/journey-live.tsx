"use client";
/**
 * Live progress for one journey, any source. The first paint is the server's `JourneyView`;
 * this component then re-reads the SAME read endpoints the API exposes and runs the SAME
 * projection function (`@/lib/platform/operator-journey`), so the page never describes a
 * state the server projection would not.
 *
 * Behaviour:
 *  - polls only while the journey is not terminal and the tab is visible; stops on terminal;
 *  - two failed reads in a row mark the view stale (the last known state stays, labelled);
 *  - a changed stage triggers one `router.refresh()` so approvals and the timeline re-render;
 *  - a changed review digest (a replan) raises a reapproval notice and refreshes the server
 *    view; earlier approvals were bound to the old digest and do not carry over;
 *  - nothing here decides authority: cancel and approve live in their own server-checked routes.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { JourneyPanel } from "@/components/platform/journey-panel";
import {
  projectLegacyDeployment,
  projectPlatformOperation,
  projectRunbookRun,
  reapprovalState,
  type JourneyView,
  type EffectLike,
  type LegacyDeploymentLike,
  type PlatformOperationLike,
  type RunbookRunLike,
  type RunbookStepLike,
} from "@/lib/platform/operator-journey";
import { browserRead } from "../_lib/browser-api";

export type JourneyTarget =
  | { kind: "platform_operation"; operationId: string }
  | { kind: "legacy_deployment"; deploymentId: string; operationId?: string }
  | { kind: "runbook_run"; runId: string; stepTitles?: Record<string, string> };

export const POLL_MS = 3000;
const MAX_QUIET_FAILURES = 2;

/** Pure: one read of the server, projected. Exported for tests. */
export async function readJourney(workspaceId: string, target: JourneyTarget, signal?: AbortSignal, effects?: readonly EffectLike[]): Promise<JourneyView> {
  if (target.kind === "platform_operation") {
    const body = await browserRead<{ operation: PlatformOperationLike }>(workspaceId, `/api/platform/v1/operations/${encodeURIComponent(target.operationId)}`, signal);
    // External effects come from the server render: an unresolved one must not disappear between polls.
    return projectPlatformOperation(effects ? { ...body.operation, effects } : body.operation);
  }
  if (target.kind === "runbook_run") {
    const body = await browserRead<{ run: RunbookRunLike; steps: RunbookStepLike[] }>(workspaceId, `/api/platform/v1/runbooks/runs/${encodeURIComponent(target.runId)}`, signal);
    return projectRunbookRun(body.run, body.steps, target.stepTitles);
  }
  const dep = (await browserRead<{ deployment: LegacyDeploymentLike }>(workspaceId, `/api/deployments/${encodeURIComponent(target.deploymentId)}`, signal)).deployment;
  let linked: PlatformOperationLike | undefined;
  if (target.operationId && dep.executor === "workflow") {
    // The control plane is the authority for a workflow deployment; a failed read falls back to the legacy record.
    linked = (await browserRead<{ operation: PlatformOperationLike }>(workspaceId, `/api/platform/v1/operations/${encodeURIComponent(target.operationId)}`, signal).catch(() => undefined))?.operation;
  }
  return projectLegacyDeployment(dep, linked && effects ? { ...linked, effects } : linked);
}

export function JourneyLive({ workspaceId, target, initial, actions, heading, pollMs = POLL_MS, effects }: {
  workspaceId: string;
  /** unresolved/known ledger effects of this operation, from the server render */
  effects?: readonly EffectLike[];
  target: JourneyTarget;
  initial: JourneyView;
  /** rendered inside the panel, under the steps */
  actions?: ReactNode;
  heading?: string;
  pollMs?: number;
}) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [updatedAt, setUpdatedAt] = useState<string>();
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const reviewed = useRef(initial.reviewDigest);
  const stage = useRef(initial.stage);
  const failures = useRef(0);
  const busy = useRef(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const [replanned, setReplanned] = useState<ReturnType<typeof reapprovalState>>({ required: false });
  const targetKey = JSON.stringify(target);
  const effectsRef = useRef(effects);
  effectsRef.current = effects;

  const read = useCallback(async (signal?: AbortSignal) => {
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);
    try {
      const next = await readJourney(workspaceId, JSON.parse(targetKey) as JourneyTarget, signal, effectsRef.current);
      failures.current = 0;
      setStale(false);
      setView(next);
      setUpdatedAt(new Date().toISOString());
      const re = reapprovalState(reviewed.current, next.reviewDigest);
      if (re.required) {
        setReplanned(re);
        // The server-rendered review is for the old digest: re-render it, and keep the notice until the viewer acknowledges.
        reviewed.current = next.reviewDigest;
        router.refresh();
      }
      if (next.stage !== stage.current) {
        stage.current = next.stage;
        router.refresh();
      }
    } catch {
      if (signal?.aborted) return;
      failures.current += 1;
      if (failures.current >= MAX_QUIET_FAILURES) setStale(true);
    } finally {
      busy.current = false;
      setRefreshing(false);
    }
  }, [workspaceId, targetKey, router]);

  // Keyboard and screen-reader users are moved to the notice: the page under them just changed.
  useEffect(() => { if (replanned.required) noticeRef.current?.focus(); }, [replanned.required]);

  useEffect(() => {
    if (view.terminal) return;
    const controller = new AbortController();
    const tick = () => { if (typeof document === "undefined" || document.visibilityState !== "hidden") void read(controller.signal); };
    const timer = setInterval(tick, pollMs);
    return () => { controller.abort(); clearInterval(timer); };
  }, [view.terminal, read, pollMs]);

  const notice = replanned.required ? (
    <div ref={noticeRef} tabIndex={-1} className="outline-none focus-visible:ring-2 focus-visible:ring-signal">
      <Callout
        tone="warn"
        live="alert"
        title="Plan changed: approval is required again"
        actions={<Button size="sm" variant="quiet" onClick={() => setReplanned({ required: false })}>I have reviewed the updated plan</Button>}
      >
        {replanned.message}
      </Callout>
    </div>
  ) : undefined;

  return (
    <JourneyPanel
      view={view}
      heading={heading}
      notice={notice}
      stale={stale}
      refreshing={refreshing}
      updatedAt={updatedAt}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <Button variant="quiet" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => void read()} disabled={refreshing} disabledReason="Refresh is already running.">Refresh</Button>
        </div>
      }
    />
  );
}
