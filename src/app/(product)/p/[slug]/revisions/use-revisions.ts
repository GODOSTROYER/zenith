"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import type { RevisionMeta } from "@/components/screens/project-data";

const PAGE = 25;
interface RevisionPage {
  revisions: RevisionMeta[];
  total: number;
  nextCursor?: string;
}

/** Keep the loaded history window intact when new revisions arrive. */
export function useRevisions(projectId: string, historyDepth: number) {
  const [loaded, setLoaded] = useState<RevisionMeta[]>([]);
  const [loadedProject, setLoadedProject] = useState(projectId);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const window = useRef({ projectId, count: 0, total: 0 });
  const generation = useRef(0);

  const page = useCallback(async (from?: string) => {
    const request = ++generation.current;
    const previous = window.current;
    setLoading(true);
    setError(undefined);
    try {
      const get = (offset?: string) => api<RevisionPage>(
        `/api/projects/${encodeURIComponent(projectId)}/revisions?limit=${PAGE}` +
        (offset ? `&cursor=${encodeURIComponent(offset)}` : "")
      );
      let response = await get(from);
      let rows = response.revisions;
      // Offset cursors move when a new revision is prepended. Re-read through
      // the previous oldest row, including every newly inserted revision.
      const keep = previous.projectId === projectId && previous.count > 0
        ? Math.max(PAGE, previous.count + Math.max(0, response.total - previous.total))
        : PAGE;
      while (!from && response.nextCursor && rows.length < keep) {
        if (request !== generation.current) return;
        response = await get(response.nextCursor);
        rows = [...rows, ...response.revisions];
      }
      if (request !== generation.current) return;
      setLoadedProject(projectId);
      setLoaded((prev) => {
        const next = from ? [...prev, ...rows] : rows;
        const unique = [...new Map(next.map((r) => [r.id, r])).values()];
        window.current = { projectId, count: unique.length, total: response.total };
        return unique;
      });
      setTotal(response.total);
      setCursor(response.nextCursor);
    } catch (e) {
      if (request === generation.current) setError(e);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (window.current.projectId !== projectId) {
      window.current = { projectId, count: 0, total: 0 };
      setLoaded([]);
      setTotal(0);
      setCursor(undefined);
    }
    if (projectId) void page();
    // This is a request generation, not a DOM ref; invalidate the current
    // request including a Load older request begun after this effect ran.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { generation.current++; };
  }, [page, projectId, historyDepth]);

  return {
    revisions: loadedProject === projectId ? loaded : [], total, error, loading,
    hasMore: cursor !== undefined,
    loadMore: () => { if (cursor && !loading) void page(cursor); },
    retry: () => { if (!loading) void page(); },
  };
}
