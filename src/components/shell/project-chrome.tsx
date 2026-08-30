"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Chip, SegmentedControl, Skeleton } from "@/components/ui";
import { useProjectData } from "@/components/shell/project-context";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import { cx, fmtUsd } from "@/lib/format";
import type { Environment } from "@/lib/domain/types";

const TABS: { seg: string; label: string }[] = [
  { seg: "", label: "System" },
  { seg: "source", label: "Source" },
  { seg: "deploys", label: "Deploys" },
  { seg: "revisions", label: "Revisions" },
  { seg: "observe", label: "Observe" },
  { seg: "security", label: "Security" },
  { seg: "activity", label: "Activity" },
  { seg: "navigator", label: "Navigator" },
  { seg: "settings", label: "Settings" },
];

/** Production is amber everywhere it appears — including in a picker. */
function EnvLabel({ env }: { env: Environment }) {
  const prod = env.class === "production";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={cx("h-1.5 w-1.5 rounded-full", prod ? "bg-prod" : "bg-ink-faint")}
      />
      {env.name}
    </span>
  );
}

export function ProjectChrome({ slug, children }: { slug: string; children: ReactNode }) {
  const { project, environments, selectedEnv, selectedEnvId, setSelectedEnv, changesets, findings } =
    useProjectData();
  const pathname = usePathname();

  const base = `/p/${slug}`;
  const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\//, "") : "";
  const activeSeg = TABS.find((t) => t.seg && rest.startsWith(t.seg))?.seg ?? "";

  const isProd = selectedEnv?.class === "production";
  const est = monthlyCostUsd(project.workingManifest);
  const pending = changesets[selectedEnvId]?.items.length ?? 0;
  const openFindings = findings.filter((f) => f.status === "open").length;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-line bg-bg1 px-4 pt-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="truncate text-[15px] font-medium text-ink">{project.name}</h1>

          {environments.length > 0 && (
            <SegmentedControl
              size="sm"
              label="Environment"
              value={selectedEnvId}
              onChange={setSelectedEnv}
              options={environments.map((e) => ({
                value: e.id,
                label: <EnvLabel env={e} />,
                title: `${e.class} · ${e.region}${
                  e.deployedRevisionId ? "" : " · never deployed"
                }`,
              }))}
            />
          )}

          {isProd && (
            <Chip tone="prod" title="Changes here affect real users. Deploys need approval.">
              production
            </Chip>
          )}

          <div className="ml-auto flex items-center gap-3">
            <span
              className="tnum text-[12.5px] text-ink-mute"
              title="Estimated monthly cost of the working system definition, at list prices."
            >
              <span className="font-mono">{fmtUsd(est)}</span>
              <span className="text-ink-faint">/mo est.</span>
            </span>
          </div>
        </div>

        <nav aria-label="Project sections" className="-mb-px flex items-end gap-1 overflow-x-auto">
          {TABS.map((t) => {
            const href = t.seg ? `${base}/${t.seg}` : base;
            const active = t.seg === activeSeg;
            const badge =
              t.seg === "" && pending > 0
                ? pending
                : t.seg === "security" && openFindings > 0
                  ? openFindings
                  : null;
            return (
              <Link
                key={t.seg || "system"}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "relative flex h-9 shrink-0 items-center gap-1.5 px-3 text-[13px] font-medium",
                  "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]",
                  active ? "text-ink" : "text-ink-mute hover:text-ink"
                )}
              >
                {t.seg === "navigator" && (
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-nav-accent" />
                )}
                {t.label}
                {badge != null && <span className="tnum text-[11.5px] text-ink-faint">{badge}</span>}
                <span
                  aria-hidden="true"
                  className={cx(
                    "absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-opacity duration-[120ms]",
                    active ? "bg-signal opacity-100" : "opacity-0"
                  )}
                />
              </Link>
            );
          })}
        </nav>
      </div>

      <div
        className={cx(
          "min-h-0 flex-1 bg-bg0",
          isProd && "border-t border-prod/60"
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Shown while the project payload is in flight, and when it cannot be read. */
export function ProjectChromeFallback({
  loading,
  message,
  fix,
}: {
  loading: boolean;
  message?: string;
  fix?: string;
}) {
  if (loading)
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  return (
    <div className="grid place-items-center p-10">
      <div className="max-w-[520px] space-y-2 text-center">
        <h1 className="text-[20px] font-medium text-ink">{message ?? "Project unavailable"}</h1>
        <p className="text-[13px] text-ink-mute">
          {fix ?? "Check the URL, or pick a project from the workspace overview."}
        </p>
        <p className="pt-2">
          <Link href="/overview" className="text-[13px] text-signal hover:underline">
            Go to the workspace overview
          </Link>
        </p>
      </div>
    </div>
  );
}
