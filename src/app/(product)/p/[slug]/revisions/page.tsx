"use client";
/**
 * Revisions — the immutable history of the system definition.
 *
 * Any two can be compared with the same diff engine the Changes drawer uses,
 * so an explanation never reads differently depending on where you found it.
 */
import { useEffect, useMemo, useState } from "react";
import { GitCompare, History, Undo2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { diffManifests } from "@/lib/domain/graph";
import type { ChangeItem, Revision } from "@/lib/domain/types";
import { cx, fmtUsd } from "@/lib/format";
import {
  Button,
  Card,
  Chip,
  CostDelta,
  EmptyState,
  Skeleton,
  TimeAgo,
} from "@/components/ui";
import { useSelectedEnv, type RevisionMeta } from "@/components/screens/project-data";
import { ActionConfirm, ActorDot, ChangeRow, ErrorNote } from "@/components/screens/shared";
import { revisionPairLabel } from "./pair-label";

const OP_ORDER: ChangeItem["op"][] = ["create", "update", "delete"];
const OP_TITLE: Record<ChangeItem["op"], string> = {
  create: "Added",
  update: "Changed",
  delete: "Removed",
};

export default function RevisionsPage() {
  const { data, env, projectId, slug, refresh } = useSelectedEnv();
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [rollbackTo, setRollbackTo] = useState<RevisionMeta | null>(null);

  const revisions = data?.revisions ?? [];

  const deployedIn = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of data?.environments ?? []) {
      if (!e.deployedRevisionId) continue;
      map.set(e.deployedRevisionId, [...(map.get(e.deployedRevisionId) ?? []), e.name]);
    }
    return map;
  }, [data]);

  if (!data)
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={20} width="30%" />
        <Skeleton height={280} />
      </div>
    );

  const toggle = (id: string) =>
    setPicked((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-2)
    );

  return (
    <div className="mx-auto h-full w-full overflow-y-auto max-w-[1100px] px-6 py-6">
      {revisions.length === 0 ? (
        <EmptyState
          icon={<History className="h-5 w-5" />}
          title="No revisions yet"
          body="A revision is snapshotted every time you deploy. Deploy once and the history starts here."
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
              {revisions.length} revision{revisions.length === 1 ? "" : "s"}
            </h2>
            <div className="flex items-center gap-2">
              {picked.length > 0 && (
                <span className="tnum text-[12.5px] text-ink-mute">
                  {picked.length} of 2 selected
                </span>
              )}
              <Button
                variant="quiet"
                icon={<GitCompare className="h-3.5 w-3.5" />}
                disabled={picked.length !== 2}
                disabledReason="Tick two revisions to compare them."
                onClick={() => setComparing(true)}
              >
                Compare
              </Button>
            </div>
          </div>

          <Card padded={false}>
            <ul>
              {revisions.map((r) => {
                const envs = deployedIn.get(r.id) ?? [];
                const checked = picked.includes(r.id);
                const liveHere = Boolean(env && envs.includes(env.name));
                return (
                  <li
                    key={r.id}
                    className={cx(
                      "flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0",
                      checked && "bg-bg3"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(r.id)}
                      aria-label={`Select revision ${r.number} for comparison`}
                      className="mt-1.5 h-3.5 w-3.5 accent-[var(--signal)]"
                    />
                    <span className="tnum mt-0.5 w-9 shrink-0 font-mono text-[13px] text-ink">
                      r{r.number}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] text-ink">{r.message}</p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-faint">
                        <ActorDot actor={r.author} />
                        {r.author.name} · <TimeAgo iso={r.createdAt} />
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {envs.map((name) => (
                        <Chip key={name} tone={name === "production" ? "prod" : "ok"}>
                          live in {name}
                        </Chip>
                      ))}
                      {/*
                        Icon-only and quiet on purpose: twenty rows of a
                        full-width destructive button reads as a wall, and a
                        wall is what you stop reading. The confirm dialog
                        (typed name in production) is unchanged.
                      */}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Undo2 className="h-3.5 w-3.5" />}
                        aria-label={
                          env ? `Roll ${env.name} back to r${r.number}` : `Roll back to r${r.number}`
                        }
                        disabled={!env || liveHere}
                        disabledReason={
                          !env
                            ? "Pick an environment in the header first."
                            : `r${r.number} is already what ${env.name} runs — there is nothing to roll back to.`
                        }
                        onClick={() => setRollbackTo(r)}
                        title={env ? `Roll ${env.name} back to r${r.number}` : undefined}
                        className="text-ink-faint hover:text-err"
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}

      {comparing && picked.length === 2 && (
        <CompareView
          ids={picked}
          revisions={revisions}
          onClose={() => setComparing(false)}
        />
      )}

      {env && (
        <ActionConfirm
          open={rollbackTo !== null}
          onClose={() => setRollbackTo(null)}
          actionId="deploy.rollback"
          input={{ environmentId: env.id, toRevisionId: rollbackTo?.id }}
          scope={{ projectId, environmentId: env.id }}
          title={`Roll ${env.name} back to r${rollbackTo?.number ?? ""}`}
          description="Rollback runs as a normal deployment, with its own steps and logs."
          confirmLabel="Roll back"
          danger
          typeToConfirm={env.class === "production" ? env.name : undefined}
          onDone={() => {
            setRollbackTo(null);
            refresh();
          }}
        />
      )}

      {slug && revisions.length > 0 && (
        <p className="mt-4 text-[12.5px] text-ink-faint">
          Revisions are append-only. The ↩ on a row rolls {env?.name ?? "the selected environment"}{" "}
          back to it, after a confirmation that shows the plan first. Rolling back deploys an
          earlier definition; it never deletes history and never restores data written since.
        </p>
      )}
    </div>
  );
}

/* -------------------------------- compare --------------------------------- */

function CompareView({
  ids,
  revisions,
  onClose,
}: {
  ids: string[];
  revisions: RevisionMeta[];
  onClose: () => void;
}) {
  const [pair, setPair] = useState<{ older: Revision; newer: Revision }>();
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let alive = true;
    setPair(undefined);
    setError(undefined);
    Promise.all(ids.map((id) => api<{ revision: Revision }>(`/api/revisions/${id}`)))
      .then(([a, b]) => {
        if (!alive) return;
        const [older, newer] =
          a.revision.number <= b.revision.number
            ? [a.revision, b.revision]
            : [b.revision, a.revision];
        setPair({ older, newer });
      })
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [ids]);

  // Numeric, not lexicographic: r9 is older than r10, whatever `.sort()` thinks.
  const heading = revisionPairLabel(
    ids.map((id) => revisions.find((r) => r.id === id)?.number)
  );

  const changeset = pair ? diffManifests(pair.older.manifest, pair.newer.manifest) : undefined;
  const grouped = OP_ORDER.map((op) => ({
    op,
    items: changeset?.items.filter((i) => i.op === op) ?? [],
  })).filter((g) => g.items.length > 0);

  return (
    <div className="mt-6 animate-enter">
      <Card
        title={`Diff ${heading}`}
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
            {grouped.map((g) => (
              <div key={g.op}>
                <h4 className="border-b border-line bg-bg1 px-4 py-2 text-[12px] tracking-[0.02em] text-ink-mute uppercase">
                  {OP_TITLE[g.op]} · {g.items.length}
                </h4>
                <ul>
                  {g.items.map((i) => (
                    <ChangeRow key={`${i.op}-${i.nodeId}`} item={i} />
                  ))}
                </ul>
              </div>
            ))}
            <div className="flex flex-wrap gap-4 border-t border-line px-4 py-3 text-[12.5px] text-ink-mute">
              <span>
                Projected monthly at the newer revision:{" "}
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
    </div>
  );
}
