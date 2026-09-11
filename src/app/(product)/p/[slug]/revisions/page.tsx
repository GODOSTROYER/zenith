"use client";
/**
 * Revisions — the immutable history of the system definition.
 *
 * Any two can be compared with the same diff engine the Changes drawer uses,
 * so an explanation never reads differently depending on where you found it.
 * Everything that leaves this screen (roll back, promote, load into the
 * working copy) goes through the action registry, plan first.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  Eye,
  GitCompare,
  History,
  Rocket,
  Search,
  Undo2,
} from "lucide-react";
import { api } from "@/lib/client/api";
import type { Environment, Revision } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table } from "@/components/ui/table";
import { TimeAgo } from "@/components/ui/time-ago";
import { useSelectedEnv, type RevisionMeta } from "@/components/screens/project-data";
import { ActionConfirm, ActorDot, ErrorNote, envTone } from "@/components/screens/shared";
import { pickPair } from "./pick-pair";
import { useRevisions } from "./use-revisions";
import { PageHeading } from "@/components/screens/page-heading";
import { CompareView, EnvironmentCompare, type Compare } from "./compare";
import { PromoteDialog, RollbackDialog, ViewDialog, type PromoteTarget } from "./dialogs";

export default function RevisionsPage() {
  const { data, env, projectId, slug, refresh } = useSelectedEnv();
  const [picked, setPicked] = useState<string[]>([]);
  const [released, setReleased] = useState<number>();
  const [compare, setCompare] = useState<Compare>();
  const [query, setQuery] = useState("");
  const [rollbackTo, setRollbackTo] = useState<RevisionMeta>();
  const [promote, setPromote] = useState<PromoteTarget>();
  /** `hash` is the working-copy token this load was planned against. */
  const [loadInto, setLoadInto] =
    useState<{ revision: RevisionMeta; manifest: unknown; hash: string }>();
  const [viewing, setViewing] = useState<{ meta: RevisionMeta; revision: Revision }>();
  /** `<revisionId>:view` | `<revisionId>:load` — only that button spins. */
  const [fetching, setFetching] = useState<string>();
  const [rowError, setRowError] = useState<unknown>();

  const {
    revisions,
    total,
    loading: listLoading,
    error: listError,
    hasMore,
    loadMore,
    retry,
  } = useRevisions(projectId, data?.revisions.length ?? 0);
  const environments = useMemo(() => data?.environments ?? [], [data]);

  /** Which environments run which revision, right now. */
  const liveIn = useMemo(() => {
    const map = new Map<string, Environment[]>();
    for (const e of environments) {
      if (!e.deployedRevisionId) continue;
      map.set(e.deployedRevisionId, [...(map.get(e.deployedRevisionId) ?? []), e]);
    }
    return map;
  }, [environments]);

  // Deep link from the Deploys screen: ?compare=<older>,<newer> or ?view=<id>.
  // Read once from location.search (same pattern as the map's ?select=) and
  // strip it, so a refresh does not re-force the panel open.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pair = params.get("compare")?.split(",").filter(Boolean) ?? [];
    const view = params.get("view");
    if (pair.length === 2) {
      setPicked(pair);
      setCompare({ ids: pair });
    } else if (view) {
      setPicked([view]);
    }
    if (pair.length === 0 && !view) return;
    params.delete("compare");
    params.delete("view");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, []);

  /** Fetch a full revision (the payload carries metadata only). */
  const fullRevision = useCallback(async (id: string): Promise<Revision> => {
    const { revision } = await api<{ revision: Revision }>(`/api/revisions/${id}`);
    return revision;
  }, []);

  if (!data)
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={20} width="30%" />
        <Skeleton height={280} />
      </div>
    );

  /** Two at a time. Say which one the third tick pushed out. */
  const toggle = (id: string) => {
    const next = pickPair(picked, id);
    setPicked(next.ids);
    setReleased(revisions.find((r) => r.id === next.released)?.number);
  };

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? revisions.filter((r) =>
        `r${r.number} ${r.message} ${r.author.name}`.toLowerCase().includes(needle)
      )
    : revisions;

  const withManifest = async (
    r: RevisionMeta,
    kind: "view" | "load",
    then: (rev: Revision) => void
  ) => {
    setFetching(`${r.id}:${kind}`);
    setRowError(undefined);
    try {
      then(await fullRevision(r.id));
    } catch (e) {
      setRowError(e);
    } finally {
      setFetching(undefined);
    }
  };

  // Newest first, so the previous revision is the next row down.
  const previousOf = (index: number): RevisionMeta | undefined => revisions[index + 1];

  return (
    <div className="product-page h-full w-full overflow-y-auto">
      <PageHeading title="Revisions" description="A precise record of your system. Compare definitions, inspect a snapshot, or review a configuration restore." actions={<Chip>{total} recorded</Chip>} />
      {listError ? <div className="mb-4 space-y-2"><ErrorNote error={listError} /><Button size="sm" variant="quiet" onClick={retry}>Retry history</Button></div> : null}
      {revisions.length === 0 && listLoading ? (
        <div className="space-y-3">
          <Skeleton height={20} width="30%" />
          <Skeleton height={280} />
        </div>
      ) : revisions.length === 0 ? (
        <EmptyState
          icon={<History className="h-5 w-5" />}
          title="No revisions yet"
          body="A revision is snapshotted every time you deploy. Deploy once and the history starts here."
        />
      ) : (
        <>
          <EnvironmentCompare
            environments={environments}
            onCompare={setCompare}
          />

          {rowError ? <ErrorNote error={rowError} className="mb-4" /> : null}

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            {/* Honest about what is loaded: search only sees the rows below. */}
            <h2 className="text-[13px] font-medium text-ink-mute">
              {needle
                ? `${shown.length} of ${revisions.length} loaded match${
                    hasMore ? ` · ${total} in all` : ""
                  }`
                : hasMore
                  ? `Showing ${revisions.length} of ${total} revisions`
                  : `${total} revision${total === 1 ? "" : "s"}`}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-[200px]">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search revisions"
                  aria-label="Search revisions by number, message or author"
                  prefix={<Search className="h-3.5 w-3.5" aria-hidden="true" />}
                />
              </div>
              {picked.length > 0 && (
                <span className="tnum text-[12.5px] text-ink-mute">
                  {picked.length} of 2 selected
                  {released !== undefined && (
                    <span className="text-ink-faint"> · r{released} unticked</span>
                  )}
                </span>
              )}
              <Button
                variant="quiet"
                icon={<GitCompare className="h-3.5 w-3.5" />}
                disabled={picked.length !== 2}
                disabledReason="Tick two revisions to compare them."
                onClick={() => setCompare({ ids: picked })}
              >
                Compare
              </Button>
            </div>
          </div>

          <Card padded={false}>
            <Table<RevisionMeta>
              caption={`${total} revision${total === 1 ? "" : "s"} of this project's system definition, newest first`}
              rows={shown}
              rowKey={(r) => r.id}
              rowClassName={(r) => (picked.includes(r.id) ? "bg-signal-dim" : undefined)}
              empty={
                <Table.Empty>
                  <p>
                    No revision matches “{query.trim()}”
                    {hasMore ? ` in the ${revisions.length} loaded so far` : ""}.
                  </p>
                  <Button size="sm" variant="quiet" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                </Table.Empty>
              }
              columns={[
                {
                  key: "pick",
                  header: "",
                  headerLabel: "Select for comparison",
                  width: 36,
                  render: (r) => (
                    <input
                      type="checkbox"
                      checked={picked.includes(r.id)}
                      onChange={() => toggle(r.id)}
                      aria-label={`Select revision ${r.number} for comparison`}
                      className="mt-1 h-3.5 w-3.5 accent-[var(--signal)]"
                    />
                  ),
                },
                {
                  key: "number",
                  header: "Rev",
                  width: 64,
                  render: (r) => (
                    <span className="tnum font-mono text-[13px] text-ink">r{r.number}</span>
                  ),
                },
                {
                  key: "message",
                  header: "Change",
                  render: (r) => (
                    <>
                      <p className="min-w-[180px] break-words text-[13px] font-medium text-ink">{r.message}</p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-faint">
                        <ActorDot actor={r.author} />
                        {r.author.name} · <TimeAgo iso={r.createdAt} />
                      </p>
                    </>
                  ),
                },
                {
                  key: "live",
                  header: "Live in",
                  render: (r) => (
                    <span className="flex flex-wrap items-center justify-end gap-2">
                      {/* Coloured by the environment's class, not by whether
                          its name happens to be the word "production". */}
                      {(liveIn.get(r.id) ?? []).map((e) => (
                        <Chip key={e.id} tone={envTone(e.class)}>
                          live in {e.name}
                        </Chip>
                      ))}
                    </span>
                  ),
                  align: "right",
                },
                {
                  key: "actions",
                  header: "",
                  headerLabel: "Actions",
                  align: "right",
                  render: (r) => {
                    const envs = liveIn.get(r.id) ?? [];
                    const liveHere = Boolean(env && envs.some((e) => e.id === env.id));
                    const previous = previousOf(revisions.indexOf(r));
                    return (
                      /* One accessible group, so a screen reader announces
                         which revision these five controls belong to. */
                      <div
                        role="group"
                        aria-label={`Actions for revision ${r.number}`}
                        className="flex items-center justify-end gap-0.5"
                      >
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<GitCompare className="h-3.5 w-3.5" />}
                          aria-label={
                            previous
                              ? `Compare r${previous.number} with r${r.number}`
                              : `Compare r${r.number} with the previous revision`
                          }
                          title={previous ? `Diff r${previous.number} → r${r.number}` : undefined}
                          disabled={!previous}
                          disabledReason={
                            hasMore
                              ? `The revision before r${r.number} is not loaded yet — use “Load older” below.`
                              : `r${r.number} is the first revision — there is nothing before it to compare with.`
                          }
                          onClick={() => previous && setCompare({ ids: [previous.id, r.id] })}
                          className="text-ink-faint hover:text-ink"
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Eye className="h-3.5 w-3.5" />}
                          aria-label={`View the manifest of r${r.number}`}
                          title={`View r${r.number} as JSON`}
                          busy={fetching === `${r.id}:view`}
                          onClick={() =>
                            withManifest(r, "view", (revision) => setViewing({ meta: r, revision }))
                          }
                          className="text-ink-faint hover:text-ink"
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
                          aria-label={`Load r${r.number} into the working copy`}
                          title={`Load r${r.number} into the working copy — edit before deploying`}
                          busy={fetching === `${r.id}:load`}
                          onClick={() =>
                            withManifest(r, "load", (revision) =>
                              setLoadInto({
                                revision: r,
                                manifest: revision.manifest,
                                // Pinned here, not read at render: a token that
                                // drifts with the poll cannot catch a race.
                                hash: data.manifestHash,
                              })
                            )
                          }
                          className="text-ink-faint hover:text-ink"
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Rocket className="h-3.5 w-3.5" />}
                          aria-label={`Promote r${r.number} to another environment`}
                          title={`Deploy r${r.number} to another environment`}
                          disabled={environments.length < 2}
                          disabledReason="Promoting needs a second environment. Create one in Settings → Environments."
                          onClick={() =>
                            setPromote({
                              revision: r,
                              environmentId:
                                environments.find((e) => e.deployedRevisionId !== r.id && e.id !== env?.id)
                                  ?.id ??
                                environments.find((e) => e.id !== env?.id)?.id ??
                                environments[0].id,
                            })
                          }
                          className="text-ink-faint hover:text-signal"
                        />
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
                    );
                  },
                },
              ]}
            />
            {hasMore && (
              <div className="border-t border-line px-4 py-3">
                <Button size="sm" variant="quiet" busy={listLoading} onClick={loadMore}>
                  Load older ({total - revisions.length} more)
                </Button>
              </div>
            )}
          </Card>
        </>
      )}

      {compare && compare.ids.length === 2 && (
        <CompareView
          ids={compare.ids}
          label={compare.label}
          revisions={revisions}
          onClose={() => setCompare(undefined)}
        />
      )}

      {env && (
        <RollbackDialog
          env={env}
          projectId={projectId}
          target={rollbackTo}
          liveIn={liveIn}
          onClose={() => setRollbackTo(undefined)}
          onDone={() => {
            setRollbackTo(undefined);
            refresh();
          }}
        />
      )}

      {promote && (
        <PromoteDialog
          projectId={projectId}
          environments={environments}
          target={promote}
          onChange={setPromote}
          onClose={() => setPromote(undefined)}
          onDone={() => {
            setPromote(undefined);
            refresh();
          }}
        />
      )}

      {loadInto && (
        <ActionConfirm
          open
          onClose={() => setLoadInto(undefined)}
          actionId="project.updateManifest"
          /* The working copy this replaces is the one that was there when the
             dialog opened; if someone saved since, the server refuses. */
          input={{ projectId, manifest: loadInto.manifest, expectedHash: loadInto.hash }}
          scope={{ projectId }}
          title={`Load r${loadInto.revision.number} into the working copy`}
          description="Replaces the working copy with this revision. Nothing deploys — the changes show up in the Changes drawer for review first."
          confirmLabel="Load into working copy"
          blockedFix={
            loadInto.hash !== data.manifestHash ? (
              <Button
                size="sm"
                variant="quiet"
                title="Re-plans this load against the working copy that is there now."
                onClick={() => setLoadInto({ ...loadInto, hash: data.manifestHash })}
              >
                Replace the newer copy anyway
              </Button>
            ) : undefined
          }
          onDone={() => {
            setLoadInto(undefined);
            refresh();
          }}
        />
      )}

      <ViewDialog target={viewing} onClose={() => setViewing(undefined)} />

      {slug && revisions.length > 0 && (
        <p className="mt-4 border-t border-line pt-4 text-[13px] text-ink-mute">
          History is append-only. Restoring a revision deploys its configuration to {env?.name ?? "the selected environment"} after review.
          It does not recover deleted data or undo application writes.
        </p>
      )}
    </div>
  );
}
