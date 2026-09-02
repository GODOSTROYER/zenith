"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { Button, CostDelta, StatusDot } from "@/components/ui";
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
   * Above 1100px the dock keeps out of that lane; when the panel is closed
   * it reclaims the space and centres over the map.
   */
  inspectorOpen?: boolean;
}

/**
 * The dock: pending changes at rest, the deployment while it runs, and the
 * activation moment when it lands. One surface, so progress is never a toast
 * you can lose.
 */
export function DeployDock({ onLiveTargets, onAddRoute, inspectorOpen = false }: DeployDockProps) {
  const { changesets, selectedEnvId, selectedEnv, deployments } = useProjectData();
  const [view, setView] = useState<View>({ at: "closed" });
  const [landedId, setLandedId] = useState<string | null>(null);
  const autoOpened = useRef("");
  const shellRef = useRef<HTMLElement | null>(null);

  const changeset = changesets[selectedEnvId];
  const pending = changeset?.items.length ?? 0;

  // Switching environment is switching subject: start from rest.
  useEffect(() => {
    setView({ at: "closed" });
  }, [selectedEnvId]);

  // A deployment that is still running owns the dock, including after a refresh.
  useEffect(() => {
    const latest = deployments.find((d) => d.environmentId === selectedEnvId);
    const key = `${selectedEnvId}:${latest?.id ?? ""}`;
    if (autoOpened.current === key) return;
    autoOpened.current = key;
    if (latest && !TERMINAL.includes(latest.status))
      setView({ at: "live", deploymentId: latest.id });
  }, [selectedEnvId, deployments]);

  const close = useCallback(() => setView({ at: "closed" }), []);

  useEffect(() => {
    if (view.at === "closed") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.at, close]);

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
   * chrome occupies: the 400px Inspector column on the right (it opens at
   * 1100px, below that it is a modal drawer), and the map's own gutter.
   */
  const shell = cx(
    "fixed bottom-4 right-6 left-6 z-40 mx-auto",
    // 400px panel + 24px gutter, but only while the panel is actually there.
    inspectorOpen && "min-[1100px]:right-[424px]"
  );

  if (view.at === "closed") {
    if (pending === 0) return null;
    return (
      <div
        ref={(el) => {
          shellRef.current = el;
        }}
        className={cx(shell, "flex max-w-[880px] justify-center")}
      >
        <button
          type="button"
          onClick={() => setView({ at: "review" })}
          className={cx(
            "animate-enter inline-flex items-center gap-3 rounded-full border border-line bg-bg2 py-2 pr-3 pl-4",
            "shadow-overlay transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]",
            "hover:border-line-strong",
            selectedEnv?.class === "production" && "ring-1 ring-prod/45"
          )}
        >
          <StatusDot status="info" pulse={false} />
          <span className="tnum text-[13px] text-ink">
            {pending} pending change{pending === 1 ? "" : "s"}
          </span>
          <span aria-hidden="true" className="text-ink-faint">
            ·
          </span>
          <CostDelta usd={changeset?.totalCostDeltaUsd ?? 0} />
          <span className="rounded-full bg-signal px-2.5 py-0.5 text-[12.5px] font-medium text-on-signal">
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
      className={cx(
        shell,
        "animate-enter flex flex-col overflow-hidden rounded-card border bg-bg2 shadow-overlay",
        landed
          ? "max-h-[calc(100vh-2rem)] max-w-[880px] min-[1100px]:max-w-[1040px]"
          : "max-h-[60vh] max-w-[880px]",
        selectedEnv?.class === "production" ? "border-prod/50 ring-1 ring-prod/45" : "border-line"
      )}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <h2 className="text-[12px] font-medium tracking-[0.04em] text-ink-faint uppercase">
          {view.at === "review" ? "Review changes" : landed ? "Live" : "Deployment"}
        </h2>
        <div className="flex items-center gap-1">
          {view.at === "live" && pending > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setView({ at: "review" })}>
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
              onDeployed={(deploymentId) => setView({ at: "live", deploymentId })}
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
            onSwitch={(deploymentId) => setView({ at: "live", deploymentId })}
            onAddRoute={onAddRoute}
            onSucceeded={setLandedId}
          />
        )}
      </div>
    </section>
  );
}
