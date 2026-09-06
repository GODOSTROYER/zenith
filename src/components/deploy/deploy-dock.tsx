"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CostDelta } from "@/components/ui/cost-delta";
import { StatusDot } from "@/components/ui/status-dot";
import { useProjectData } from "@/components/shell/project-context";
import { cx } from "@/lib/format";
import type { DeploymentStatus } from "@/lib/domain/types";
import { ChangesReview } from "./changes-review";
import { DeploymentView } from "./live-progress";

const TERMINAL: DeploymentStatus[] = ["succeeded", "failed", "rolled_back", "cancelled"];

type View = { at: "closed" } | { at: "review" } | { at: "live"; deploymentId: string };

export interface DeployDockProps {
  /** node ids a running step is touching — the map pulses them */
  onLiveTargets: (ids: string[]) => void;
  /** "add a custom domain" from the success panel opens the route form */
  onAddRoute: () => void;
  /**
   * True while the Inspector panel occupies its 400px lane on the right.
   * Above 1400px — the width where the panel docks rather than going modal —
   * the dock keeps out of that lane; when the panel is closed it reclaims the
   * space and centres over the map.
   */
  inspectorOpen?: boolean;
  /** Deep link (?review=1): open on the changes review once, if anything is pending. */
  openReview?: boolean;
}

/**
 * The dock: pending changes at rest, the deployment while it runs, and the
 * activation moment when it lands. One surface, so progress is never a toast
 * you can lose.
 */
export function DeployDock({
  onLiveTargets,
  onAddRoute,
  inspectorOpen = false,
  openReview = false,
}: DeployDockProps) {
  const { changesets, selectedEnvId, selectedEnv, deployments } = useProjectData();
  const [view, setView] = useState<View>({ at: "closed" });
  const [landedId, setLandedId] = useState<string | null>(null);
  const autoOpened = useRef("");
  const shellRef = useRef<HTMLElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  // Only a click or Esc moves focus. An environment switch or a deployment
  // starting elsewhere changes this dock too, and must not steal the caret.
  const userToggled = useRef(false);

  const changeset = changesets[selectedEnvId];
  const pending = changeset?.items.length ?? 0;

  const open = useCallback((next: View) => {
    userToggled.current = true;
    setView(next);
  }, []);

  /** What this environment is serving right now, for the resting chip. */
  const liveUrl = useMemo(() => {
    const latest = deployments.find((d) => d.environmentId === selectedEnvId);
    if (!latest || latest.status !== "succeeded") return undefined;
    const url = latest.outputs.find((o) => o.kind === "url");
      return url && { href: url.value, label: url.label, simulated: url.simulated };
  }, [deployments, selectedEnvId]);

  // Switching environment is switching subject: start from rest.
  useEffect(() => {
    setView({ at: "closed" });
  }, [selectedEnvId]);

  // A deep link asked for the review: honour it once, only while there is
  // something to review, and never over a running deployment.
  const reviewOpened = useRef(false);
  useEffect(() => {
    if (!openReview || reviewOpened.current || pending === 0) return;
    reviewOpened.current = true;
    setView((v) => (v.at === "closed" ? { at: "review" } : v));
  }, [openReview, pending]);

  // A deployment that is still running owns the dock, including after a refresh.
  useEffect(() => {
    const latest = deployments.find((d) => d.environmentId === selectedEnvId);
    const key = `${selectedEnvId}:${latest?.id ?? ""}`;
    if (autoOpened.current === key) return;
    autoOpened.current = key;
    if (latest && !TERMINAL.includes(latest.status))
      setView({ at: "live", deploymentId: latest.id });
  }, [selectedEnvId, deployments]);

  const close = useCallback(() => {
    userToggled.current = true;
    setView({ at: "closed" });
  }, []);

  useEffect(() => {
    if (view.at === "closed") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.at, close]);

  // Every view change destroys the control that was focused — expanding kills
  // the pill, collapsing kills the panel, deploying kills the Deploy button.
  // Without this, focus lands on <body> and the keyboard is lost mid-task.
  // Only transitions the operator asked for move focus (`userToggled`); the
  // dock re-opening itself for a running deployment must not steal it.
  useEffect(() => {
    if (!userToggled.current) return;
    userToggled.current = false;
    (view.at === "closed" ? pillRef.current : shellRef.current)?.focus();
  }, [view]);

  // The dock owns a strip of the bottom edge; the toast stack sits above it.
  useEffect(() => {
    const el = shellRef.current;
    const root = document.documentElement;
    const clear = () => root.style.removeProperty("--orrery-dock-h");
    if (!el) {
      clear();
      return;
    }
    const ro = new ResizeObserver(() =>
      root.style.setProperty(
        "--orrery-dock-h",
        // clamped: a toast pushed off the top of the window is worse than a
        // toast resting on a dock that already fills most of the screen
        `${Math.min(el.offsetHeight + 12, window.innerHeight * 0.55)}px`
      )
    );
    ro.observe(el);
    return () => {
      ro.disconnect();
      clear();
    };
  }, [view.at, pending]);

  /**
   * Bottom-anchored and out of flow, so it has to reserve the lanes other
   * chrome occupies: the 400px Inspector column on the right (it docks at
   * 1400px, below that it is a modal drawer), and the map's own gutter.
   */
  const shell = cx(
    "absolute bottom-3 right-3 left-3 z-40 mx-auto sm:bottom-4 sm:right-5 sm:left-5",
    // 400px panel + 24px gutter, but only while the panel is actually there.
    // 1400px is where the Inspector docks (useWideLayout); below it the panel
    // is a modal drawer and there is no lane to keep out of.
    inspectorOpen && "min-[1400px]:right-[424px]"
  );

  if (view.at === "closed") {
    // Nothing pending and nothing running: say what this environment is
    // serving, so the live address never disappears between deployments.
    if (pending === 0) {
      if (!liveUrl) return null;
      const name = liveUrl.label.split(" — ")[0];
      return (
        <div
          ref={(el) => {
            shellRef.current = el;
          }}
          className={cx(shell, "flex max-w-[880px] justify-center")}
        >
          <a
            href={liveUrl.href}
            target="_blank"
            rel="noreferrer"
            title={`Open ${name} as ${selectedEnv?.name ?? "this environment"} runs it now`}
            className={cx(
              "animate-enter inline-flex items-center gap-2.5 rounded-card border border-line bg-bg2 py-2 pr-3 pl-3.5",
              "text-[12.5px] text-ink-mute shadow-overlay transition-colors duration-[120ms]",
              "[transition-timing-function:var(--ease-swift)] hover:border-line-strong hover:text-ink"
            )}
          >
            <StatusDot status="ok" />
            {liveUrl.simulated ? "Simulated output" : "Deployment output"}
            <span aria-hidden="true" className="text-ink-faint">
              ·
            </span>
            <span className="max-w-[220px] truncate font-mono text-ink">{name}</span>
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </a>
        </div>
      );
    }
    return (
      <div
        ref={(el) => {
          shellRef.current = el;
        }}
        className={cx(shell, "flex max-w-[880px] justify-center")}
      >
        <button
          type="button"
          ref={pillRef}
          onClick={() => open({ at: "review" })}
          className={cx(
            "animate-enter inline-flex max-w-full flex-wrap items-center justify-center gap-2 rounded-card border border-line bg-bg2 py-2 pr-3 pl-4 sm:gap-3",
            "shadow-overlay transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]",
            "hover:border-line-strong",
            selectedEnv?.class === "production" && "ring-1 ring-prod/45"
          )}
        >
          <StatusDot status="info" pulse={false} />
          <span className={cx("text-[12px] font-medium", selectedEnv?.class === "production" ? "text-prod" : "text-ink-mute")}>{selectedEnv?.name}{selectedEnv?.class === "production" ? " · production" : ""}</span>
          <span className="tnum text-[13px] text-ink">
            {pending} pending change{pending === 1 ? "" : "s"}
          </span>
          <span aria-hidden="true" className="text-ink-faint">
            ·
          </span>
          <CostDelta usd={changeset?.totalCostDeltaUsd ?? 0} />
          <span className="rounded-ctl bg-signal px-2.5 py-1 text-[12.5px] font-medium text-on-signal">
            Review
          </span>
        </button>
      </div>
    );
  }

  // The activation moment is the peak of the product; it does not get a 60vh
  // scrollbox. It takes the whole panel, headline to health chips.
  const landed = view.at === "live" && landedId === view.deploymentId;

  return (
    <section
      ref={(el) => {
        shellRef.current = el;
      }}
      aria-label="Changes and deployment"
      tabIndex={-1}
      className={cx(
        "outline-none",
        shell,
        "animate-enter flex flex-col overflow-hidden rounded-card border bg-bg2 shadow-overlay",
        landed
          ? "max-h-[calc(100%-2rem)] max-w-[960px]"
          : "max-h-[min(78vh,calc(100%-2rem))] max-w-[960px]",
        selectedEnv?.class === "production" ? "border-prod/50 ring-1 ring-prod/45" : "border-line"
      )}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <h2 className="text-[13px] font-semibold text-ink">
          {view.at === "review" ? "Change review" : landed ? "Deployment complete" : "Deployment"}<span className="ml-2 font-normal text-ink-mute">{selectedEnv?.name}</span>
        </h2>
        <div className="flex items-center gap-1">
          {view.at === "live" && pending > 0 && (
            <Button size="sm" variant="ghost" onClick={() => open({ at: "review" })}>
              Pending changes ({pending})
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={close}
            aria-label="Collapse panel"
            title="Collapse (Esc)"
            icon={
              view.at === "review" ? (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              ) : (
                <X className="h-4 w-4" aria-hidden="true" />
              )
            }
          />
        </div>
      </header>

      <div className={cx("min-h-0 flex-1 overflow-y-auto", landed ? "p-6" : "p-4")}>
        {view.at === "review" ? (
          changeset && pending > 0 ? (
            <ChangesReview
              changeset={changeset}
              onDeployed={(deploymentId) => open({ at: "live", deploymentId })}
            />
          ) : (
            <p className="py-6 text-center text-[13px] text-ink-mute">
              Nothing pending — {selectedEnv?.name ?? "this environment"} already runs the working
              system. Edit something on the map and it will show up here.
            </p>
          )
        ) : (
          <DeploymentView
            deploymentId={view.deploymentId}
            onLiveTargets={onLiveTargets}
            onSwitch={(deploymentId) => open({ at: "live", deploymentId })}
            onAddRoute={onAddRoute}
            onSucceeded={setLandedId}
            // A retry is the same review, same changeset, same idempotency key
            // family — not a second deployment started blind.
            onRetry={pending > 0 ? () => open({ at: "review" }) : undefined}
          />
        )}
      </div>
    </section>
  );
}
