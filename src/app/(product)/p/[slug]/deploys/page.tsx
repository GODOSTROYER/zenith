"use client";
/**
 * Deploys — every apply this environment has seen, and everything that
 * happened inside the selected one.
 *
 * This file owns the paging and the selection; the rail is deployment-list.tsx
 * and everything about one deployment is deployment-detail.tsx.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Rocket } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PageHeading } from "@/components/screens/page-heading";
import { api } from "@/lib/client/api";
import type { Deployment } from "@/lib/domain/types";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectData } from "@/components/shell/project-context";
import { useSelectedEnv } from "@/components/screens/project-data";
import { ErrorNote } from "@/components/screens/shared";
import { DeploymentDetail } from "./deployment-detail";
import { DeploymentList } from "./deployment-list";
import { PAGE_SIZE, STATUS_LABEL, type DeploymentPage, type StatusFilter } from "./status";
import { readHistoryWindow } from "./history-window";

export default function DeploysPage() {
  return <Suspense fallback={<div className="product-page"><Skeleton height={280} /></div>}><DeploysWorkspace /></Suspense>;
}

function DeploysWorkspace() {
  const requested = useSearchParams().get("deployment");
  const { data, env, projectId, slug, refresh, setSelectedEnv } = useSelectedEnv();
  // The polled workspace payload — how this screen learns that a deployment
  // started somewhere else (the map dock, the Navigator, another tab).
  const { deployments: liveDeployments } = useProjectData();
  const [loadedList, setList] = useState<Deployment[]>();
  const [loadedBase, setLoadedBase] = useState<string>();
  const [query, setQuery] = useState("");
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [error, setError] = useState<unknown>();
  const [selectedId, setSelectedId] = useState<string>();
  const [linkedDeployment, setLinkedDeployment] = useState<Deployment>();
  const [linkedError, setLinkedError] = useState<unknown>();
  const [reloadTick, setReloadTick] = useState(0);
  const loadedWindow = useRef({ base: "", count: 0, total: 0 });
  const generation = useRef(0);
  const selectEnv = useRef(setSelectedEnv);
  useEffect(() => { selectEnv.current = setSelectedEnv; }, [setSelectedEnv]);

  const envId = env?.id;
  const base = envId
    ? `/api/environments/${envId}/deployments?limit=${PAGE_SIZE}${status === "all" ? "" : `&status=${status}`}`
    : null;
  // Context changes must not paint an old environment's rows under a new name.
  const list = loadedBase === base ? loadedList : undefined;

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  useEffect(() => {
    // The route remains mounted when a notification or command changes only
    // its query. Replace linked state and invalidate the previous request.
    setLinkedDeployment(undefined);
    setLinkedError(undefined);
    setSelectedId(undefined);
    if (!requested) return;
    let alive = true;
    api<{ deployment: Deployment }>(`/api/deployments/${encodeURIComponent(requested)}`)
      .then(({ deployment }) => {
        if (!alive) return;
        if (deployment.projectId !== projectId) throw new Error("This deployment belongs to another project. Open it from that project's Deploys history.");
        setLinkedDeployment(deployment);
        setSelectedId(deployment.id);
        selectEnv.current(deployment.environmentId);
      })
      .catch((e: unknown) => { if (alive) setLinkedError(e); });
    return () => { alive = false; };
  }, [projectId, requested]);

  // Only a different environment or filter drops the selection and the list; a
  // reload after a deploy settles must not yank the operator off the row they
  // are reading, flash a skeleton, or throw away the streamed log buffer.
  useEffect(() => {
    setSelectedId(undefined);
    setList(undefined);
    setCursor(undefined);
    setLoadingOlder(false);
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
    const request = ++generation.current;
    const previous = loadedWindow.current;
    readHistoryWindow(base, previous.base === base ? previous.count : 0, previous.total, api<DeploymentPage>, () => alive && generation.current === request)
      .then((page) => {
        if (!alive || !page) return;
        loadedWindow.current = { base, count: page.deployments.length, total: page.total };
        setLoadedBase(base);
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
    const request = generation.current;
    setLoadingOlder(true);
    try {
      const page = await api<DeploymentPage>(`${base}&cursor=${encodeURIComponent(cursor)}`);
      if (request !== generation.current) return;
      setList((prev) => {
        const next = [...new Map([...(prev ?? []), ...page.deployments].map((d) => [d.id, d])).values()];
        loadedWindow.current = { base, count: next.length, total: page.total };
        return next;
      });
      setTotal(page.total);
      setCursor(page.nextCursor);
      setError(undefined);
    } catch (e) {
      if (request === generation.current) setError(e);
    } finally {
      if (request === generation.current) setLoadingOlder(false);
    }
  };

  const selected = useMemo(
    () => list?.find((d) => d.id === selectedId) ??
      (linkedDeployment && linkedDeployment.environmentId === envId && (!selectedId || selectedId === linkedDeployment.id) ? linkedDeployment : undefined) ?? list?.[0],
    [list, selectedId, linkedDeployment, envId]
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
    <div className="product-page h-full w-full overflow-y-auto">
      <PageHeading title="Deploys" description={`Deployment history and outcomes for ${env.name}. Select a deployment to inspect its steps and outputs.`} />
      {error ? <div className="mb-4 space-y-2"><ErrorNote error={error} /><Button size="sm" variant="quiet" onClick={reload}>Retry deployment history</Button></div> : null}
      {linkedError ? <ErrorNote error={linkedError} className="mb-4" /> : null}

      {list && list.length === 0 && status === "all" && !selected ? (
        <EmptyState
          icon={<Rocket className="h-5 w-5" />}
          title="No deployments yet"
          body={`Nothing has been applied to ${env.name}. Review your pending changes on the System map, then deploy.`}
          action={<Link href={`/p/${slug}?env=${encodeURIComponent(env.id)}`} className="ui-button inline-flex h-9 items-center rounded-ctl bg-signal px-3.5 text-[13px] font-medium text-on-signal hover:bg-signal-strong">Review changes on the map</Link>}
        />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
          <DeploymentList
            envName={env.name}
            list={list}
            shown={shown}
            total={total}
            status={status}
            query={query}
            cursor={cursor}
            loadingOlder={loadingOlder}
            selectedId={selected?.id}
            revisionNumbers={revisionNumbers}
            onStatus={(next) => { setLinkedDeployment(undefined); setStatus(next); }}
            onQuery={setQuery}
            onSelect={(id) => { setLinkedDeployment(undefined); setSelectedId(id); }}
            onLoadOlder={loadOlder}
          />

          <section aria-label="Selected deployment" className="min-w-0 lg:border-l lg:border-line lg:pl-6">
            {selected ? (
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
            ) : list ? (
              <EmptyState title="No deployment selected" body="Choose another status filter to inspect deployment steps, logs, and outputs." />
            ) : error ? null : (
              <Skeleton height={360} />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
