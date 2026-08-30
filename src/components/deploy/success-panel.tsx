"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Gauge, Globe, ScrollText } from "lucide-react";
import { Button, Chip, CopyButton, StatusDot, type DotStatus } from "@/components/ui";
import { OrbitMark } from "@/components/shell/wordmark";
import { useProjectData } from "@/components/shell/project-context";
import { useJson } from "@/lib/client/api";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import { cx, fmtUsd } from "@/lib/format";
import type { Deployment, Output } from "@/lib/domain/types";

interface HealthPayload {
  simulated: boolean;
  services: Record<
    string,
    { status: "ok" | "degraded"; replicasReady: number; replicasDesired: number; latencyMs: number }
  >;
}

/** `web — https://web--staging.atlas.orrery.app` → the two halves. */
function splitLabel(label: string): { name: string; pretty: string } {
  const at = label.indexOf(" — ");
  if (at < 0) return { name: label, pretty: label };
  return { name: label.slice(0, at), pretty: label.slice(at + 3) };
}

function firstLiveEver(projectId: string): boolean {
  const key = `orrery-first-live-${projectId}`;
  try {
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, new Date().toISOString());
    return true;
  } catch {
    return false; // no storage, no celebration — never a broken panel
  }
}

function OutputRow({ output }: { output: Output }) {
  const { name, pretty } = splitLabel(output.label);
  const isUrl = output.kind === "url";
  return (
    <li className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
      <Globe className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-ink">{name}</p>
        <p className="truncate font-mono text-[12px] text-ink-mute" title={pretty}>
          {pretty}
        </p>
      </div>
      <CopyButton value={pretty} what="the address" label="Copy" />
      {isUrl && (
        <a
          href={output.value}
          target="_blank"
          rel="noreferrer"
          className={cx(
            "inline-flex h-7 items-center gap-1.5 rounded-ctl border border-transparent bg-signal px-2.5",
            "text-[12.5px] font-medium text-on-signal hover:bg-signal-strong",
            "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]"
          )}
        >
          Open
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      )}
    </li>
  );
}

export function SuccessPanel({
  deployment,
  onAddRoute,
}: {
  deployment: Deployment;
  onAddRoute: () => void;
}) {
  const { project, selectedEnv, selectedEnvId } = useProjectData();
  const [celebrate] = useState(() => firstLiveEver(project.id));
  const { data: health } = useJson<HealthPayload>(
    selectedEnv?.deployedRevisionId ? `/api/health/${selectedEnvId}` : null,
    10_000
  );

  const urls = deployment.outputs.filter((o) => o.kind === "url");
  const others = deployment.outputs.filter((o) => o.kind !== "url");
  const est = monthlyCostUsd(project.workingManifest);
  const services = project.workingManifest.services;

  return (
    <div className="animate-enter space-y-5">
      <div className="flex items-center gap-3">
        <OrbitMark size={36} draw={celebrate} className="text-signal" />
        <div>
          <h2 className="text-[40px] leading-none font-medium tracking-[-0.02em] text-ink">
            Live.
          </h2>
          <p className="mt-1.5 text-[13px] text-ink-mute">
            {deployment.changeSummary} on {selectedEnv?.name ?? "this environment"}
            {selectedEnv?.class === "sandbox" || selectedEnv?.class === "staging"
              ? " · simulated environment"
              : ""}
            .
          </p>
        </div>
      </div>

      {urls.length > 0 ? (
        <ul className="overflow-hidden rounded-card border border-line bg-bg1">
          {urls.map((o) => (
            <OutputRow key={o.key} output={o} />
          ))}
        </ul>
      ) : (
        <p className="rounded-card border border-line bg-bg1 px-4 py-3 text-[13px] text-ink-mute">
          Nothing in this system answers HTTP, so there is no address to open. Publish a route to
          give it a public front door.
        </p>
      )}

      {others.length > 0 && (
        <ul className="overflow-hidden rounded-card border border-line bg-bg1">
          {others.map((o) => (
            <li
              key={o.key}
              className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-mute">
                {o.label}
              </span>
              <CopyButton value={o.value} what="the value" label="Copy" />
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {health?.services &&
          Object.entries(health.services).map(([serviceId, h]) => {
            const name = services.find((s) => s.id === serviceId)?.name ?? serviceId;
            const dot: DotStatus = h.status === "ok" ? "ok" : "warn";
            return (
              <Chip
                key={serviceId}
                tone={h.status === "ok" ? "ok" : "warn"}
                icon={<StatusDot status={dot} size={6} />}
                title={`${h.replicasReady}/${h.replicasDesired} ready · ${h.latencyMs}ms — simulated health.`}
              >
                {name} {h.replicasReady}/{h.replicasDesired}
              </Chip>
            );
          })}
        <span className="tnum ml-auto font-mono text-[12.5px] text-ink-mute">
          now {fmtUsd(est)}
          <span className="text-ink-faint">/mo est.</span>
        </span>
      </div>

      <div className="space-y-2 border-t border-line pt-4">
        <h3 className="text-[12px] font-medium tracking-[0.04em] text-ink-faint uppercase">Next</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="quiet"
            icon={<Globe className="h-3.5 w-3.5" aria-hidden="true" />}
            onClick={onAddRoute}
          >
            Add a custom domain
          </Button>
          <Link href={`/p/${project.slug}/observe`}>
            <Button
              size="sm"
              variant="quiet"
              icon={<ScrollText className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              Watch the logs
            </Button>
          </Link>
          <Link href={`/p/${project.slug}/settings`}>
            <Button
              size="sm"
              variant="quiet"
              icon={<Gauge className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              {selectedEnv?.policies.budgetUsdMonthly
                ? "Review the budget"
                : "Set a monthly budget"}
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
