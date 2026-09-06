"use client";
/**
 * Deploys — every apply this environment has seen, and everything that
 * happened inside the selected one.
 *
 * This file owns the paging and the selection; the rail is deployment-list.tsx
 * and everything about one deployment is deployment-detail.tsx.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Rocket } from "lucide-react";
import Link from "next/link";
import { PageHeading } from "@/components/screens/page-heading";
import { api } from "@/lib/client/api";
import type { Deployment } from "@/lib/domain/types";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectData } from "@/components/shell/project-context";
import { useSelectedEnv } from "@/components/screens/project-data";
import { ErrorNote } from "@/components/screens/shared";
import { DeploymentDetail } from "./deployment-detail";
import { DeploymentList } from "./deployment-list";
import { PAGE_SIZE, STATUS_LABEL, type DeploymentPage, type StatusFilter } from "./status";

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
    <div className="product-page mx-auto h-full w-full max-w-[1240px] overflow-y-auto">
      <PageHeading title="Deploys" description={`Deployment history and outcomes for ${env.name}. Select a deployment to inspect its steps and outputs.`} />
      {error ? <ErrorNote error={error} className="mb-4" /> : null}

      {list && list.length === 0 && status === "all" ? (
        <EmptyState
          icon={<Rocket className="h-5 w-5" />}
          title="No deployments yet"
          body={`Nothing has been applied to ${env.name}. Review your pending changes on the System map, then deploy.`}
          action={<Link href={`/p/${slug}?env=${encodeURIComponent(env.id)}`} className="ui-button inline-flex h-9 items-center rounded-ctl bg-signal px-3.5 text-[13px] font-medium text-on-signal hover:bg-signal-strong">Review changes on the map</Link>}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
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
            onStatus={setStatus}
            onQuery={setQuery}
            onSelect={setSelectedId}
            onLoadOlder={loadOlder}
          />

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
