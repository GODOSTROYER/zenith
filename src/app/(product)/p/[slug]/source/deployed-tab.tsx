"use client";
/**
 * A deployed snapshot: the exact manifest a revision carries, and what the
 * working copy would change if it were deployed over it right now.
 */
import { useMemo, useState } from "react";
import { FileJson } from "lucide-react";
import { useJson } from "@/lib/client/api";
import { diffManifests } from "@/lib/domain/graph";
import type { Manifest, Revision } from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { CodeBlock } from "@/components/ui/code-block";
import { CostDelta } from "@/components/ui/cost-delta";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { RevisionMeta } from "@/components/screens/project-data";
import { ChangeRow, ErrorNote } from "@/components/screens/shared";

/* -------------------------------- deployed -------------------------------- */

export function DeployedTab({
  revisions,
  deployedRevisionId,
  envName,
  working,
}: {
  revisions: RevisionMeta[];
  deployedRevisionId: string | undefined;
  envName: string | undefined;
  working: Manifest;
}) {
  const [chosen, setChosen] = useState(deployedRevisionId ?? revisions[0]?.id ?? "");
  const loaded = useJson<{ revision: Revision }>(chosen ? `/api/revisions/${chosen}` : null);
  const revision = loaded.data?.revision;

  // What the working copy would change if it were deployed here right now.
  const drift = useMemo(
    () => (revision ? diffManifests(revision.manifest, working) : undefined),
    [revision, working]
  );

  if (revisions.length === 0)
    return (
      <EmptyState
        icon={<FileJson className="h-5 w-5" />}
        title={`${envName ?? "This environment"} has never been deployed`}
        body="Once a revision is live here, its exact manifest shows up for comparison against the working copy."
      />
    );

  const where = envName ?? "this environment";
  const isLive = !!deployedRevisionId && chosen === deployedRevisionId;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="w-[280px]"
          aria-label="Revision to show"
          value={chosen}
          onChange={(e) => setChosen(e.target.value)}
          options={revisions.map((r) => ({
            value: r.id,
            label: `r${r.number}${r.id === deployedRevisionId ? " · live here" : ""} — ${r.message}`,
          }))}
        />
        <Chip tone={isLive ? "signal" : "neutral"}>
          {isLive ? `live in ${where}` : "not running here"}
        </Chip>
        {revision && (
          <span className="text-[12.5px] text-ink-mute">
            {revision.message}
            <span className="text-ink-faint"> · {revision.author.name}</span>
          </span>
        )}
      </div>

      {!deployedRevisionId && (
        <p className="text-[12.5px] text-ink-mute">
          {where} has never been deployed — nothing below is running there. This is the recorded
          revision, shown for comparison.
        </p>
      )}

      {loaded.error ? <ErrorNote error={loaded.error} /> : null}
      {!revision || !drift ? (
        loaded.error ? null : (
          <Skeleton height={360} />
        )
      ) : (
        <>
          <Card
            title={
              drift.items.length === 0
                ? `The working copy matches r${revision.number}`
                : `${drift.items.length} change${drift.items.length === 1 ? "" : "s"} in the working copy, not in r${revision.number}`
            }
            subtitle={
              drift.items.length === 0
                ? `r${revision.number} and the working copy describe the same system.`
                : `Deploying the working copy ${isLive ? `to ${where}` : "over this revision"} would apply these. Projected ${fmtUsd(drift.projectedMonthlyUsd)}/month afterwards (estimate).`
            }
            actions={
              drift.items.length > 0 ? <CostDelta usd={drift.totalCostDeltaUsd} /> : undefined
            }
            padded={drift.items.length === 0}
          >
            {drift.items.length === 0 ? null : (
              <ul className="-mx-1">
                {drift.items.map((i) => (
                  <ChangeRow key={`${i.op}-${i.nodeId}`} item={i} />
                ))}
              </ul>
            )}
          </Card>

          <CodeBlock
            code={JSON.stringify(revision.manifest, null, 2)}
            title={`r${revision.number}${isLive ? ` — live in ${where}` : ""}`}
            lineNumbers
            maxHeight={560}
          />
        </>
      )}
    </div>
  );
}
