"use client";
/**
 * Revisions — the immutable history of the system definition.
 *
 * Any two can be compared with the same diff engine the Changes drawer uses,
 * so an explanation never reads differently depending on where you found it.
 * Everything that leaves this screen (roll back, promote, load into the
 * working copy) goes through the action registry, plan first.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { diffManifests } from "@/lib/domain/graph";
import type { ChangeItem, Environment, Revision } from "@/lib/domain/types";
import { cx, fmtUsd } from "@/lib/format";
import {
  Button,
  Card,
  Chip,
  CodeBlock,
  CostDelta,
  Dialog,
  EmptyState,
  Input,
  Select,
  Skeleton,
  TimeAgo,
} from "@/components/ui";
import {
  useSelectedEnv,
  type ProjectPayload,
  type RevisionMeta,
} from "@/components/screens/project-data";
import {
  ActionConfirm,
  ActorDot,
  ChangeRow,
  ErrorNote,
  envTone,
} from "@/components/screens/shared";
import { revisionPairLabel } from "./pair-label";
import { pickPair } from "./pick-pair";

const OP_ORDER: ChangeItem["op"][] = ["create", "update", "delete"];
const OP_TITLE: Record<ChangeItem["op"], string> = {
  create: "Added",
  update: "Changed",
  delete: "Removed",
};

/**
 * Where the list comes from. Today the project payload carries the whole
 * append-only history; when the cursor-paged revisions route lands, this
 * function is the only thing that changes.
 */
function fetchRevisions(data: ProjectPayload): RevisionMeta[] {
  return data.revisions;
}

/** What a comparison is about: two revision ids and how to name the pair. */
interface Compare {
  ids: string[];
  /** overrides the "r3 → r7" heading, e.g. "staging → production" */
  label?: string;
}

export default function RevisionsPage() {
  const { data, env, projectId, slug, refresh } = useSelectedEnv();
  const [picked, setPicked] = useState<string[]>([]);
  const [released, setReleased] = useState<number>();
  const [compare, setCompare] = useState<Compare>();
  const [query, setQuery] = useState("");
  const [rollbackTo, setRollbackTo] = useState<RevisionMeta>();
  const [promote, setPromote] = useState<{ revision: RevisionMeta; environmentId: string }>();
  const [loadInto, setLoadInto] = useState<{ revision: RevisionMeta; manifest: unknown }>();
  const [viewing, setViewing] = useState<{ meta: RevisionMeta; revision: Revision }>();
  /** `<revisionId>:view` | `<revisionId>:load` — only that button spins. */
  const [fetching, setFetching] = useState<string>();
  const [rowError, setRowError] = useState<unknown>();

  const revisions = data ? fetchRevisions(data) : [];
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
    <div className="mx-auto h-full w-full max-w-[1100px] overflow-y-auto px-6 py-6">
      {revisions.length === 0 ? (
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
            <h2 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
              {needle
                ? `${shown.length} of ${revisions.length} revisions match`
                : `${revisions.length} revision${revisions.length === 1 ? "" : "s"}`}
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
            <ul>
              {shown.map((r) => {
                const envs = liveIn.get(r.id) ?? [];
                const checked = picked.includes(r.id);
                const liveHere = Boolean(env && envs.some((e) => e.id === env.id));
                const previous = previousOf(revisions.indexOf(r));
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
                      {/* Coloured by the environment's class, not by whether
                          its name happens to be the word "production". */}
                      {envs.map((e) => (
                        <Chip key={e.id} tone={envTone(e.class)}>
                          live in {e.name}
                        </Chip>
                      ))}
                      {/* One accessible group, so a screen reader announces
                          which revision these five controls belong to. */}
                      <div
                        role="group"
                        aria-label={`Actions for revision ${r.number}`}
                        className="flex items-center gap-0.5"
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
                          disabledReason={`r${r.number} is the first revision — there is nothing before it to compare with.`}
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
                              setLoadInto({ revision: r, manifest: revision.manifest })
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
                    </div>
                  </li>
                );
              })}
            </ul>
            {shown.length === 0 && (
              <div className="space-y-3 px-4 py-5 text-[13px] text-ink-mute">
                <p>No revision matches “{query.trim()}”.</p>
                <Button size="sm" variant="quiet" onClick={() => setQuery("")}>
                  Clear search
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
        <ActionConfirm
          open={rollbackTo !== undefined}
          onClose={() => setRollbackTo(undefined)}
          actionId="deploy.rollback"
          input={{ environmentId: env.id, toRevisionId: rollbackTo?.id }}
          scope={{ projectId, environmentId: env.id }}
          title={`Roll ${env.name} back to r${rollbackTo?.number ?? ""}`}
          description="Rollback runs as a normal deployment, with its own steps and logs."
          confirmLabel="Roll back"
          danger
          typeToConfirm={env.class === "production" ? env.name : undefined}
          onDone={() => {
            setRollbackTo(undefined);
            refresh();
          }}
        >
          <LeavingNote env={env} liveIn={liveIn} />
        </ActionConfirm>
      )}

      {promote && (
        <ActionConfirm
          open
          onClose={() => setPromote(undefined)}
          // Same action, same plan-first path: the engine already deploys any
          // revision to any environment. Only the verb differs.
          actionId="deploy.rollback"
          input={{ environmentId: promote.environmentId, toRevisionId: promote.revision.id }}
          scope={{ projectId, environmentId: promote.environmentId }}
          title={`Promote r${promote.revision.number} to ${
            environments.find((e) => e.id === promote.environmentId)?.name ?? "another environment"
          }`}
          description="Deploys this exact revision to another environment — the working copy is not touched."
          confirmLabel="Promote"
          danger={
            environments.find((e) => e.id === promote.environmentId)?.class === "production"
          }
          typeToConfirm={
            environments.find((e) => e.id === promote.environmentId)?.class === "production"
              ? environments.find((e) => e.id === promote.environmentId)?.name
              : undefined
          }
          onDone={() => {
            setPromote(undefined);
            refresh();
          }}
        >
          <div className="space-y-2">
            <label className="block space-y-1.5">
              <span className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
                Deploy r{promote.revision.number} to
              </span>
              <Select
                value={promote.environmentId}
                onChange={(e) => setPromote({ ...promote, environmentId: e.target.value })}
                options={environments.map((e) => ({
                  value: e.id,
                  label:
                    e.deployedRevisionId === promote.revision.id
                      ? `${e.name} — already runs r${promote.revision.number}`
                      : e.name,
                  disabled: e.deployedRevisionId === promote.revision.id,
                }))}
              />
            </label>
            <p className="text-[12px] text-ink-faint">
              Promote and roll back are one operation: deploy a chosen revision to an environment.
              The preview below is generated by that action and still words it as a rollback.
            </p>
          </div>
        </ActionConfirm>
      )}

      {loadInto && (
        <ActionConfirm
          open
          onClose={() => setLoadInto(undefined)}
          actionId="project.updateManifest"
          input={{ projectId, manifest: loadInto.manifest }}
          scope={{ projectId }}
          title={`Load r${loadInto.revision.number} into the working copy`}
          description="Replaces the working copy with this revision. Nothing deploys — the changes show up in the Changes drawer for review first."
          confirmLabel="Load into working copy"
          onDone={() => {
            setLoadInto(undefined);
            refresh();
          }}
        />
      )}

      <Dialog
        open={viewing !== undefined}
        onClose={() => setViewing(undefined)}
        title={`r${viewing?.meta.number ?? ""} — ${viewing?.meta.message ?? ""}`}
        description="The exact manifest this revision deployed. Revisions are immutable; this is read-only."
        width={720}
        footer={
          <Button variant="quiet" onClick={() => setViewing(undefined)}>
            Close
          </Button>
        }
      >
        {viewing?.revision && (
          <CodeBlock
            code={JSON.stringify(viewing.revision.manifest, null, 2)}
            title={`r${viewing.meta.number}.json`}
            lineNumbers
            maxHeight={460}
          />
        )}
      </Dialog>

      {slug && revisions.length > 0 && (
        <p className="mt-4 text-[12.5px] text-ink-faint">
          Revisions are append-only. The ↩ on a row rolls {env?.name ?? "the selected environment"}{" "}
          back to it and the rocket deploys it to another environment; both show the plan first.
          Deploying an earlier definition never deletes history and never restores data written
          since.
        </p>
      )}
    </div>
  );
}

/* --------------------------- cross-environment ---------------------------- */

/**
 * "What is different between staging and production" — the same diff engine,
 * run over the two revisions those environments actually run.
 */
function EnvironmentCompare({
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
    <div className="mb-5 flex flex-wrap items-end gap-3 rounded-card border border-line bg-bg1 px-4 py-3">
      <div className="min-w-0">
        <p className="mb-1.5 text-[12px] tracking-[0.02em] text-ink-mute uppercase">
          Compare environments
        </p>
        <div className="flex items-center gap-2">
          <div className="w-[160px]">
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
          <div className="w-[160px]">
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
function LeavingNote({
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

function CompareView({
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
  const panel = useRef<HTMLDivElement>(null);

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
    <div ref={panel} tabIndex={-1} className="mt-6 animate-enter outline-none">
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
