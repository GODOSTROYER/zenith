"use client";
/**
 * Comparing revisions: the cross-environment picker, the panel that diffs two
 * revisions, and the note about who else runs what an environment is leaving.
 *
 * The diff itself is the same engine the Changes drawer uses, so an
 * explanation never reads differently depending on where you found it.
 */
import { useEffect, useRef, useState } from "react";
import { GitCompare } from "lucide-react";
import { api } from "@/lib/client/api";
import { diffManifests } from "@/lib/domain/graph";
import type { ChangeItem, Environment, Revision } from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { CodeBlock } from "@/components/ui/code-block";
import { CostDelta } from "@/components/ui/cost-delta";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { RevisionMeta } from "@/components/screens/project-data";
import { ChangeRow, ErrorNote } from "@/components/screens/shared";
import { ConnectedDetail } from "@/components/screens/connected-detail";
import { revisionPairLabel } from "./pair-label";
import { orderComparison } from "./order-comparison";

const OP_ORDER: ChangeItem["op"][] = ["create", "update", "delete"];
const OP_TITLE: Record<ChangeItem["op"], string> = {
  create: "Added",
  update: "Changed",
  delete: "Removed",
};

/** What a comparison is about: two revision ids and how to name the pair. */
export interface Compare {
  ids: string[];
  /** overrides the "r3 → r7" heading, e.g. "staging → production" */
  label?: string;
}

/* --------------------------- cross-environment ---------------------------- */

/**
 * "What is different between staging and production" — the same diff engine,
 * run over the two revisions those environments actually run.
 */
export function EnvironmentCompare({
  environments,
  onCompare,
}: {
  environments: Environment[];
  onCompare: (c: Compare) => void;
}) {
  const deployed = environments.filter((e) => e.deployedRevisionId);
  const [a, setA] = useState("");
  const [b, setB] = useState("");

  useEffect(() => {
    setA((prev) => (deployed.some((e) => e.id === prev) ? prev : (deployed[0]?.id ?? "")));
    setB((prev) => (deployed.some((e) => e.id === prev) ? prev : (deployed[1]?.id ?? "")));
    // deployed is derived from environments; recomputing on each render is fine
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environments]);

  if (deployed.length < 2) return null;

  const envA = deployed.find((e) => e.id === a);
  const envB = deployed.find((e) => e.id === b);
  const same = a === b;
  const options = deployed.map((e) => ({ value: e.id, label: e.name }));

  return (
    <div className="mb-6 flex flex-wrap items-end gap-4 border-y border-line py-4">
      <div className="min-w-0">
        <p className="mb-2 text-[13px] font-medium text-ink">
          Compare environments
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-[min(160px,35vw)]">
            <Select
              value={a}
              onChange={(e) => setA(e.target.value)}
              options={options}
              aria-label="Compare from environment"
            />
          </div>
          <span aria-hidden="true" className="text-ink-faint">
            →
          </span>
          <div className="w-[min(160px,35vw)]">
            <Select
              value={b}
              onChange={(e) => setB(e.target.value)}
              options={options}
              aria-label="Compare to environment"
            />
          </div>
        </div>
      </div>
      <Button
        variant="quiet"
        icon={<GitCompare className="h-3.5 w-3.5" />}
        disabled={same || !envA || !envB}
        disabledReason="Pick two different environments — comparing one with itself has nothing to show."
        onClick={() =>
          envA &&
          envB &&
          onCompare({
            ids: [envA.deployedRevisionId!, envB.deployedRevisionId!],
            label: `${envA.name} → ${envB.name}`,
          })
        }
      >
        Compare
      </Button>
      <p className="text-[12px] text-ink-faint">
        Diffs what each environment is running right now.
      </p>
    </div>
  );
}

/** Other environments that run what this one is about to leave behind. */
export function LeavingNote({
  env,
  liveIn,
}: {
  env: Environment;
  liveIn: Map<string, Environment[]>;
}) {
  const current = env.deployedRevisionId;
  const others = current ? (liveIn.get(current) ?? []).filter((e) => e.id !== env.id) : [];
  if (others.length === 0) return null;
  return (
    <p className="rounded-card border border-line bg-bg1 px-3 py-2 text-[12.5px] text-ink-mute">
      {others.map((e) => e.name).join(" and ")} {others.length === 1 ? "also runs" : "also run"} what{" "}
      {env.name} is leaving. Rolling {env.name} back does not change{" "}
      {others.length === 1 ? "it" : "them"}.
    </p>
  );
}

/* -------------------------------- compare --------------------------------- */

export function CompareView({
  ids,
  label,
  revisions,
  onClose,
}: {
  ids: string[];
  label?: string;
  revisions: RevisionMeta[];
  onClose: () => void;
}) {
  const [pair, setPair] = useState<{ older: Revision; newer: Revision }>();
  const [error, setError] = useState<unknown>();
  const [selectedChange, setSelectedChange] = useState<ChangeItem>();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setPair(undefined);
    setError(undefined);
    setSelectedChange(undefined);
    Promise.all(ids.map((id) => api<{ revision: Revision }>(`/api/revisions/${id}`)))
      .then(([a, b]) => {
        if (!alive) return;
        const [older, newer] = orderComparison(a.revision, b.revision, Boolean(label));
        setPair({ older, newer });
      })
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [ids, label]);

  // The panel opens below the fold on a long history. Focusing it scrolls it
  // into view and puts the keyboard where the new content is.
  useEffect(() => {
    panel.current?.focus();
  }, [ids]);

  // Numeric, not lexicographic: r9 is older than r10, whatever `.sort()` thinks.
  const heading =
    label ?? revisionPairLabel(ids.map((id) => revisions.find((r) => r.id === id)?.number));

  const changeset = pair ? diffManifests(pair.older.manifest, pair.newer.manifest) : undefined;
  const grouped = OP_ORDER.map((op) => ({
    op,
    items: changeset?.items.filter((i) => i.op === op) ?? [],
  })).filter((g) => g.items.length > 0);

  return (
    <div ref={panel} tabIndex={-1} className="mt-6 scroll-mt-6 outline-none">
      <Card
        title={`Compare ${heading}`}
        subtitle={
          pair
            ? `From r${pair.older.number} “${pair.older.message}” to r${pair.newer.number} “${pair.newer.message}”.`
            : "Loading both revisions…"
        }
        actions={
          <>
            {changeset && <CostDelta usd={changeset.totalCostDeltaUsd} />}
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </>
        }
        padded={false}
      >
        {error ? (
          <div className="p-5">
            <ErrorNote error={error} />
          </div>
        ) : !changeset ? (
          <div className="space-y-2 p-5">
            <Skeleton height={16} />
            <Skeleton height={16} width="80%" />
          </div>
        ) : changeset.items.length === 0 ? (
          <EmptyState
            title="Identical systems"
            body="These two revisions describe exactly the same services, resources, routes and bindings."
          />
        ) : (
          <div>
            {pair && <div className="grid gap-4 border-b border-line bg-bg1 p-4 sm:grid-cols-2">
              <div><p className="text-[12px] text-ink-mute">Source revision</p><p className="mt-1 break-words text-[14px] text-ink"><span className="font-mono">r{pair.older.number}</span> · {pair.older.message}</p></div>
              <div><p className="text-[12px] text-ink-mute">Target revision</p><p className="mt-1 break-words text-[14px] text-ink"><span className="font-mono">r{pair.newer.number}</span> · {pair.newer.message}</p></div>
            </div>}
            {grouped.map((g) => (
              <div key={g.op}>
                <h4 className="border-b border-line bg-bg1 px-4 py-2 text-[13px] font-medium text-ink-mute">
                  {OP_TITLE[g.op]} · {g.items.length}
                </h4>
                <ul>
                  {g.items.map((i) => (
                    <ChangeRow key={`${i.op}-${i.nodeId}`} item={i} selected={selectedChange?.nodeId === i.nodeId && selectedChange?.op === i.op} onSelect={() => setSelectedChange(i)} />
                  ))}
                </ul>
              </div>
            ))}
            <div className="flex flex-wrap gap-4 border-t border-line px-4 py-3 text-[12.5px] text-ink-mute">
              <span>
                Projected monthly at the target revision:{" "}
                <span className="tnum text-ink">{fmtUsd(changeset.projectedMonthlyUsd)}</span> (est.)
              </span>
              {changeset.warnings.map((w) => (
                <span key={w} className="text-warn">
                  {w}
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>
      <ConnectedDetail open={Boolean(selectedChange)} onClose={() => setSelectedChange(undefined)} title={selectedChange?.nodeName ?? "Revision change"} resourceId={selectedChange?.nodeId} context={pair ? `r${pair.older.number} → r${pair.newer.number} · immutable comparison` : "Revision comparison"}>
        {selectedChange && <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2"><Chip tone={selectedChange.op === "delete" ? "err" : selectedChange.op === "create" ? "ok" : "signal"}>{OP_TITLE[selectedChange.op]}</Chip><Chip tone={selectedChange.risk === "high" ? "warn" : "neutral"}>{selectedChange.risk} risk</Chip><CostDelta usd={selectedChange.costDeltaUsd} /></div>
          <p className="text-[13px] text-ink-mute">{selectedChange.explanation}</p>
          {pair && <><CodeBlock title={`Source · r${pair.older.number}`} code={JSON.stringify(changeDefinition(pair.older, selectedChange), null, 2)} maxHeight={280} /><CodeBlock title={`Target · r${pair.newer.number}`} code={JSON.stringify(changeDefinition(pair.newer, selectedChange), null, 2)} maxHeight={280} /></>}
          <p className="text-[12px] text-ink-mute">Historical definitions are read-only. Review a restore from the revision history to change an environment.</p>
        </div>}
      </ConnectedDetail>
    </div>
  );
}

export function changeDefinition(revision: Revision, change: ChangeItem) {
  const manifest = revision.manifest;
  return [...manifest.services, ...manifest.resources, ...manifest.routes, ...manifest.bindings].find((item) => item.id === change.nodeId) ?? null;
}
