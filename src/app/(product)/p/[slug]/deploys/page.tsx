"use client";
/**
 * Deploys — every apply this environment has seen, and everything that
 * happened inside the selected one.
 *
 * A deployment in flight streams; a finished one replays the same event log
 * from seq 0, so history and live look identical and a refresh loses nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink, GitCompare, Rocket, Search } from "lucide-react";
import { api, useEventStream } from "@/lib/client/api";
import type {
  Deployment,
  DeploymentEvent,
  DeploymentStatus,
  Output,
} from "@/lib/domain/types";
import {
  Button,
  Card,
  Chip,
  CopyButton,
  CostDelta,
  EmptyState,
  Input,
  LogViewer,
  PhaseTimeline,
  SegmentedControl,
  Skeleton,
  StatusDot,
  Table,
  TimeAgo,
  type DotStatus,
  type LogLine,
} from "@/components/ui";
import { useProjectData } from "@/components/shell/project-context";
import { useShell } from "@/components/shell/shell-context";
import { roleAllows, roleReason, useRequiredRole } from "@/components/deploy/caller-role";
import { copyTarget, isSimulated, openLabel } from "@/components/deploy/output-link";
import { useSelectedEnv } from "@/components/screens/project-data";
import { ActionConfirm, ActorDot, ErrorNote } from "@/components/screens/shared";

const STREAM_EVENTS = ["status", "step", "log", "output"];

const TERMINAL: DeploymentStatus[] = ["succeeded", "failed", "rolled_back", "cancelled"];

const STATUS_DOT: Record<DeploymentStatus, DotStatus> = {
  planning: "running",
  awaiting_approval: "warn",
  applying: "running",
  verifying: "running",
  succeeded: "ok",
  failed: "err",
  rolling_back: "running",
  rolled_back: "warn",
  cancelled: "idle",
};

const STATUS_LABEL: Record<DeploymentStatus, string> = {
  planning: "Planning",
  awaiting_approval: "Awaiting approval",
  applying: "Applying",
  verifying: "Verifying",
  succeeded: "Succeeded",
  failed: "Failed",
  rolling_back: "Rolling back",
  rolled_back: "Rolled back",
  cancelled: "Cancelled",
};

const isLive = (s: DeploymentStatus) => !TERMINAL.includes(s);

/** One page of `GET /api/environments/:id/deployments`. */
interface DeploymentPage {
  deployments: Deployment[];
  /** how many match the filter in total — so the count on screen is honest */
  total: number;
  nextCursor?: string;
}

/** The endpoint's own vocabulary, so the filter needs no translation table. */
type StatusFilter = "all" | "live" | "terminal";

const PAGE_SIZE = 50;

const FILTER_LABEL: Record<StatusFilter, string> = {
  all: "deployment",
  live: "deployment in flight",
  terminal: "finished deployment",
};

export default function DeploysPage() {
  const { data, env, projectId, slug, refresh } = useSelectedEnv();
  // The polled workspace payload — how this screen learns that a deployment
  // started somewhere else (the map dock, the Navigator, another tab).
  const { deployments: liveDeployments } = useProjectData();
  const [list, setList] = useState<Deployment[]>();
  const [query, setQuery] = useState("");
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [error, setError] = useState<unknown>();
  const [selectedId, setSelectedId] = useState<string>();
  const [reloadTick, setReloadTick] = useState(0);

  const envId = env?.id;
  const base = envId
    ? `/api/environments/${envId}/deployments?limit=${PAGE_SIZE}${status === "all" ? "" : `&status=${status}`}`
    : null;

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  // Only a different environment or filter drops the selection and the list; a
  // reload after a deploy settles must not yank the operator off the row they
  // are reading, flash a skeleton, or throw away the streamed log buffer.
  useEffect(() => {
    setSelectedId(undefined);
    setList(undefined);
    setCursor(undefined);
  }, [base]);

  // A deployment that started elsewhere shows up in the polled payload before
  // this list knows about it. Refetch when that set changes — but not on the
  // first pass, which the fetch below is already covering.
  const liveKey = liveDeployments
    .filter((d) => d.environmentId === envId)
    .map((d) => `${d.id}:${d.status}`)
    .join(",");
  const seenLive = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (seenLive.current !== undefined && seenLive.current !== liveKey) reload();
    seenLive.current = liveKey;
  }, [liveKey, reload]);

  useEffect(() => {
    if (!base) return;
    let alive = true;
    api<DeploymentPage>(base)
      .then((page) => {
        if (!alive) return;
        setList(page.deployments);
        setTotal(page.total);
        setCursor(page.nextCursor);
        setError(undefined);
      })
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [base, reloadTick]);

  const loadOlder = async () => {
    if (!base || !cursor) return;
    setLoadingOlder(true);
    try {
      const page = await api<DeploymentPage>(`${base}&cursor=${encodeURIComponent(cursor)}`);
      setList((prev) => [...(prev ?? []), ...page.deployments]);
      setTotal(page.total);
      setCursor(page.nextCursor);
      setError(undefined);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingOlder(false);
    }
  };

  const selected = useMemo(
    () => list?.find((d) => d.id === selectedId) ?? list?.[0],
    [list, selectedId]
  );

  const revisionNumbers = useMemo(
    () => new Map((data?.revisions ?? []).map((r) => [r.id, r.number])),
    [data]
  );

  // Search over what is loaded, and say so — "Load older" fetches the rest.
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!list || !needle) return list;
    return list.filter((d) =>
      [
        d.changeSummary,
        d.actor.name,
        STATUS_LABEL[d.status],
        `r${revisionNumbers.get(d.revisionId) ?? ""}`,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [list, needle, revisionNumbers]);

  if (!data || !env)
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={20} width="30%" />
        <Skeleton height={280} />
      </div>
    );

  return (
    <div className="mx-auto h-full w-full overflow-y-auto max-w-[1240px] px-6 py-6">
      {error ? <ErrorNote error={error} className="mb-4" /> : null}

      {list && list.length === 0 && status === "all" ? (
        <EmptyState
          icon={<Rocket className="h-5 w-5" />}
          title="No deployments yet"
          body={`Nothing has been applied to ${env.name}. Review your pending changes on the System map, then deploy.`}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <aside className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
                {env.name} ·{" "}
                {!list
                  ? "loading…"
                  : needle
                    ? `${shown?.length ?? 0} of ${list.length} loaded ${FILTER_LABEL[status]}${(shown?.length ?? 0) === 1 ? "" : "s"} match`
                    : `${list.length === total ? list.length : `${list.length} of ${total}`} ${FILTER_LABEL[status]}${total === 1 ? "" : "s"}`}
              </h2>
              <SegmentedControl<StatusFilter>
                size="sm"
                label="Filter deployments by status"
                value={status}
                onChange={setStatus}
                options={[
                  { value: "all", label: "All" },
                  { value: "live", label: "In flight", title: "Planning, applying, verifying or awaiting approval" },
                  { value: "terminal", label: "Finished", title: "Succeeded, failed, rolled back or cancelled" },
                ]}
              />
            </div>
            <div className="mb-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search loaded deployments"
                aria-label="Search deployments by summary, who ran them, status or revision"
                prefix={<Search className="h-3.5 w-3.5" aria-hidden="true" />}
              />
            </div>
            <div className="overflow-hidden rounded-card border border-line bg-bg2">
              {!list ? (
                <div className="space-y-2 p-4">
                  <Skeleton height={44} />
                  <Skeleton height={44} />
                  <Skeleton height={44} />
                </div>
              ) : list.length === 0 ? (
                <div className="space-y-3 px-4 py-5 text-[13px] text-ink-mute">
                  <p>
                    No {FILTER_LABEL[status]}s in {env.name} right now
                    {total === 0 && " — nothing matches this filter."}
                  </p>
                  <Button size="sm" variant="quiet" onClick={() => setStatus("all")}>
                    Show all deployments
                  </Button>
                </div>
              ) : shown && shown.length === 0 ? (
                <div className="space-y-3 px-4 py-5 text-[13px] text-ink-mute">
                  <p>
                    Nothing loaded matches “{query.trim()}”. Older deployments are fetched a page at
                    a time — load more, or clear the search.
                  </p>
                  <Button size="sm" variant="quiet" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                </div>
              ) : (
                <Table<Deployment>
                  caption={`Deployments to ${env.name}, newest first — pick one to see its steps, logs and outputs`}
                  wrapperClassName="overflow-y-auto lg:max-h-[70vh]"
                  rows={shown ?? list}
                  rowKey={(d) => d.id}
                  selectedKey={selected?.id}
                  onSelectRow={(d) => setSelectedId(d.id)}
                  columns={[
                    {
                      key: "status",
                      header: "",
                      headerLabel: "Status",
                      width: 26,
                      render: (d) => (
                        <StatusDot
                          status={STATUS_DOT[d.status]}
                          pulse={isLive(d.status)}
                          label={STATUS_LABEL[d.status]}
                        />
                      ),
                    },
                    {
                      key: "deployment",
                      header: "Deployment",
                      render: (d) => (
                        <>
                          <span className="flex items-baseline gap-2">
                            <span className="tnum font-mono text-[12px] text-ink">
                              r{revisionNumbers.get(d.revisionId) ?? "?"}
                            </span>
                            <span className="truncate text-[13px] text-ink">
                              {d.changeSummary}
                            </span>
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-faint">
                            <ActorDot actor={d.actor} />
                            {d.actor.name} · <TimeAgo iso={d.createdAt} />
                          </span>
                        </>
                      ),
                    },
                  ]}
                />
              )}
              {list && cursor ? (
                <div className="border-t border-line p-2">
                  <Button
                    size="sm"
                    variant="quiet"
                    block
                    busy={loadingOlder}
                    onClick={loadOlder}
                    title={`Fetch the next ${PAGE_SIZE} older deployments`}
                  >
                    Load older ({total - list.length} more)
                  </Button>
                </div>
              ) : null}
            </div>
          </aside>

          <section className="min-w-0">
            {list && list.length === 0 ? null : selected ? (
              <DeploymentDetail
                key={selected.id}
                snapshot={selected}
                envName={env.name}
                isProd={env.class === "production"}
                environmentId={env.id}
                connectionId={env.connectionId}
                projectId={projectId}
                slug={slug}
                revisionNumbers={revisionNumbers}
                onChanged={() => {
                  reload();
                  refresh();
                }}
              />
            ) : (
              <Skeleton height={360} />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/* -------------------------------- detail ---------------------------------- */

/** A long deployment must not grow the tab's memory without bound. */
const MAX_BUFFERED_LINES = 2000;

function DeploymentDetail({
  snapshot,
  envName,
  isProd,
  environmentId,
  connectionId,
  projectId,
  slug,
  revisionNumbers,
  onChanged,
}: {
  snapshot: Deployment;
  envName: string;
  isProd: boolean;
  environmentId: string;
  connectionId: string;
  projectId: string | undefined;
  slug: string;
  revisionNumbers: Map<string, number>;
  onChanged: () => void;
}) {
  const { boot } = useShell();
  const approveRole = useRequiredRole("deploy.approve", "admin");
  const [dep, setDep] = useState<Deployment>(snapshot);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [confirm, setConfirm] = useState<null | "approve" | "cancel" | "rollback">(null);

  const revisionNumber = revisionNumbers.get(snapshot.revisionId);

  useEffect(() => {
    setDep(snapshot);
  }, [snapshot]);

  const onEvent = useCallback((type: string, raw: unknown) => {
    const e = raw as DeploymentEvent;
    if (type === "log" && e.type === "log") {
      setLines((prev) =>
        [...prev, { seq: e.seq, stream: e.stream, line: e.line, ts: e.ts }].slice(
          -MAX_BUFFERED_LINES
        )
      );
      return;
    }
    setDep((prev) => {
      if (type === "status" && e.type === "status") return { ...prev, status: e.status };
      if (type === "step" && e.type === "step")
        return {
          ...prev,
          steps: prev.steps.map((s) =>
            s.id === e.stepId ? { ...s, status: e.status, error: e.error ?? s.error } : s
          ),
        };
      if (type === "output" && e.type === "output")
        return prev.outputs.some((o) => o.key === e.output.key)
          ? prev
          : { ...prev, outputs: [...prev.outputs, e.output] };
      return prev;
    });
  }, []);

  const { connected } = useEventStream(
    `/api/deployments/${snapshot.id}/events`,
    STREAM_EVENTS,
    onEvent,
    onChanged
  );

  const scope = { projectId, environmentId };
  const live = isLive(dep.status);
  const previousNumber = dep.previousRevisionId
    ? revisionNumbers.get(dep.previousRevisionId)
    : undefined;
  // "What changed" is the diff between the revision this replaced and the one
  // it deployed — the Revisions screen already renders exactly that.
  const changedHref = dep.previousRevisionId
    ? `/p/${slug}/revisions?compare=${dep.previousRevisionId},${dep.revisionId}`
    : `/p/${slug}/revisions?view=${dep.revisionId}`;
  // Only the sandbox hands out addresses nothing answers on. `undefined` until
  // the workspace payload lands — unknown is not "real".
  const envSimulated = boot
    ? boot.connections.find((c) => c.id === connectionId)?.provider === "sandbox"
    : undefined;

  return (
    <div className="space-y-5">
      <Card
        prod={isProd}
        title={
          <span className="flex items-center gap-2.5">
            <StatusDot status={STATUS_DOT[dep.status]} pulse={live} />
            {STATUS_LABEL[dep.status]}
            <span className="tnum font-mono text-[13px] text-ink-mute">
              r{revisionNumber ?? "?"}
            </span>
          </span>
        }
        subtitle={
          <>
            {dep.changeSummary} · {envName} · <TimeAgo iso={dep.createdAt} /> ·{" "}
            <span title="Estimated change to the monthly bill this deployment carried.">
              <CostDelta usd={dep.estCostDeltaUsd} /> est./mo
            </span>
          </>
        }
        actions={
          <>
            {isProd && <Chip tone="prod">production</Chip>}
            {live && (
              <Chip tone={connected ? "signal" : "warn"}>
                {connected ? "streaming" : "reconnecting"}
              </Chip>
            )}
            <Link href={changedHref}>
              <Button
                size="sm"
                variant="quiet"
                icon={<GitCompare className="h-3.5 w-3.5" aria-hidden="true" />}
                title={
                  previousNumber
                    ? `Diff r${previousNumber} against r${revisionNumber ?? "?"}`
                    : `Show r${revisionNumber ?? "?"} — the first revision this environment ran`
                }
              >
                {dep.previousRevisionId ? "What changed" : "View revision"}
              </Button>
            </Link>
          </>
        }
      >
        <PhaseTimeline steps={dep.steps} />
      </Card>

      {dep.status === "awaiting_approval" && (
        <Card
          prod={isProd}
          title="This deployment is waiting for you"
          subtitle={`${envName} requires approval before anything is applied. Nothing has changed yet.`}
        >
          <div className="flex gap-2">
            <Button
              onClick={() => setConfirm("approve")}
              disabled={!roleAllows(boot, approveRole)}
              disabledReason={roleReason(boot, approveRole, "Approving a deployment")}
            >
              Approve and apply
            </Button>
            <Button variant="quiet" onClick={() => setConfirm("cancel")}>
              Cancel deployment
            </Button>
          </div>
        </Card>
      )}

      {(dep.status === "failed" || dep.status === "cancelled") && (
        <Card
          title={dep.status === "failed" ? "This deployment failed" : "This deployment was cancelled"}
          subtitle={
            dep.status === "failed"
              ? "Remaining steps were skipped. The environment is between two revisions until you roll back or deploy again."
              : "Steps that had already finished stayed applied. The environment is between two revisions until you roll back or deploy again."
          }
        >
          {dep.error && <ErrorNote error={new Error(dep.error)} className="mb-3" />}
          <Button
            variant="danger"
            disabled={!dep.previousRevisionId}
            disabledReason={`This was the first deployment to ${envName} — there is no earlier revision to return to. Fix the working copy and deploy again.`}
            onClick={() => setConfirm("rollback")}
          >
            Roll {envName} back{previousNumber ? ` to r${previousNumber}` : ""}
          </Button>
        </Card>
      )}

      {/* A good deployment can still be the one you want to undo. */}
      {dep.status === "succeeded" && dep.previousRevisionId && (
        <div className="flex justify-end">
          <Button
            variant="quiet"
            size="sm"
            onClick={() => setConfirm("rollback")}
            title={`Deploy r${previousNumber ?? "?"} — what ${envName} ran before this — as a new deployment`}
          >
            Roll {envName} back to r{previousNumber ?? "?"}
          </Button>
        </div>
      )}

      {live && dep.status !== "awaiting_approval" && (
        <div className="flex justify-end">
          <Button variant="quiet" size="sm" onClick={() => setConfirm("cancel")}>
            Cancel deployment
          </Button>
        </div>
      )}

      {dep.outputs.length > 0 && (
        <Card
          title="Outputs"
          subtitle="Live for this environment. They stay on the environment after the deployment ends."
          padded={false}
        >
          <ul>
            {dep.outputs.map((o) => (
              <OutputRow key={o.key} output={o} envSimulated={envSimulated} />
            ))}
          </ul>
        </Card>
      )}

      <div>
        <h3 className="mb-2 text-[12px] tracking-[0.02em] text-ink-mute uppercase">
          Deployment log
        </h3>
        <LogViewer
          lines={lines}
          height={340}
          label={`Deployment log for r${revisionNumber ?? "?"} on ${envName}`}
          downloadName={`${envName}-r${revisionNumber ?? "x"}-deploy.log`}
          emptyMessage={
            live
              ? "Waiting for the first line — steps narrate as they run."
              : "This deployment recorded no log lines."
          }
        />
      </div>

      <ActionConfirm
        open={confirm === "approve"}
        onClose={() => setConfirm(null)}
        actionId="deploy.approve"
        input={{ deploymentId: dep.id }}
        scope={scope}
        title="Approve this deployment"
        description={`It starts changing ${envName} immediately.`}
        confirmLabel="Approve and apply"
        onDone={onChanged}
      />
      <ActionConfirm
        open={confirm === "cancel"}
        onClose={() => setConfirm(null)}
        actionId="deploy.cancel"
        input={{ deploymentId: dep.id }}
        scope={scope}
        title="Cancel this deployment"
        confirmLabel="Cancel deployment"
        danger
        onDone={onChanged}
      />
      <ActionConfirm
        open={confirm === "rollback"}
        onClose={() => setConfirm(null)}
        actionId="deploy.rollback"
        // The revision THIS deployment replaced — not whatever the environment
        // happens to have replaced most recently.
        input={{ environmentId, toRevisionId: dep.previousRevisionId }}
        scope={scope}
        title={`Roll ${envName} back${previousNumber ? ` to r${previousNumber}` : ""}`}
        description="Runs as a normal deployment, with its own steps and logs. It restores the system definition, not data written since."
        confirmLabel="Roll back"
        danger
        typeToConfirm={isProd ? envName : undefined}
        onDone={onChanged}
      />
    </div>
  );
}

/**
 * `label` is the pretty hostname; `value` is the href that actually works —
 * but only for `url` outputs. A connection string is "postgres.staging…:5432"
 * with no scheme: as an href the browser resolves it against this app and
 * lands on a 404, so a connection gets Copy and nothing else.
 */
function OutputRow({ output, envSimulated }: { output: Output; envSimulated: boolean | undefined }) {
  const pretty = output.label.includes(" — ")
    ? output.label.slice(output.label.indexOf(" — ") + 3)
    : output.label;
  const isUrl = output.kind === "url";
  const simulated = isSimulated(output, envSimulated);
  const copy = copyTarget(output, simulated);

  return (
    <li className="flex items-center gap-3 border-b border-line px-5 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[12.5px] text-ink">{output.label}</p>
        <p className="text-[11.5px] text-ink-faint">{output.kind}</p>
      </div>
      {isUrl && simulated !== false && (
        <Chip
          title={
            simulated
              ? `${pretty} does not exist on the internet. Open shows a local preview served by the sandbox provider.`
              : "Checking which provider produced this address."
          }
        >
          {simulated ? "simulated" : "checking…"}
        </Chip>
      )}
      <CopyButton value={copy.value} what={copy.what} size="sm" variant="ghost" />
      {isUrl && (
        <a
          href={output.value}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-7 items-center gap-1.5 rounded-ctl border border-line bg-bg2 px-2.5 text-[12.5px] text-ink hover:border-line-strong"
        >
          {openLabel(simulated)}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      )}
    </li>
  );
}
