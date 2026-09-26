"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { WaitlistEntry, WaitlistPage } from "@/lib/waitlist/types";

interface PendingBatch { count: number; requestId: string }

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  try { return await response.json(); } catch { return {}; }
}

function requestError(response: Response, body: Record<string, unknown>, fallback: string): string {
  if (response.status === 401) return "Your session has expired. Sign in again to continue.";
  if (response.status === 403) return "This account does not have waitlist operator access.";
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error === "object" && "message" in body.error && typeof body.error.message === "string") return body.error.message;
  return fallback;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function WaitlistQueue({ operatorId }: { operatorId: string }) {
  const [status, setStatus] = useState<WaitlistEntry["status"]>("queued");
  const [cursors, setCursors] = useState<Array<number | null>>([null]);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<WaitlistPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [batchSize, setBatchSize] = useState("100");
  const [pendingBatch, setPendingBatch] = useState<PendingBatch | null>(null);
  const [pendingRestored, setPendingRestored] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [admitting, setAdmitting] = useState(false);
  const [admitError, setAdmitError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const admissionInFlight = useRef(false);
  const after = cursors[cursors.length - 1];
  const storageKey = `zenith:waitlist:pending-admission:${operatorId}`;

  useEffect(() => {
    let restored: PendingBatch | null = null;
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const batch: unknown = JSON.parse(saved);
        if (batch && typeof batch === "object" && "count" in batch && "requestId" in batch &&
          typeof batch.count === "number" && Number.isInteger(batch.count) && batch.count >= 1 && batch.count <= 1000 &&
          typeof batch.requestId === "string" && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(batch.requestId)) {
          restored = { count: batch.count, requestId: batch.requestId };
        }
      }
    } catch {
      setStorageAvailable(false);
    }
    setPendingBatch(restored);
    if (restored) setBatchSize(String(restored.count));
    setPendingRestored(true);
  }, [storageKey]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(undefined);
    const params = new URLSearchParams({ status, limit: "100" });
    if (after !== null) params.set("after", String(after));

    void (async () => {
      try {
        const response = await fetch(`/api/admin/waitlist?${params}`, { cache: "no-store", signal: controller.signal });
        const body = await responseBody(response);
        if (!response.ok) throw new Error(requestError(response, body, "The waitlist could not be loaded. Try again."));
        if (!Array.isArray(body.entries)) throw new Error("The waitlist response was incomplete. Try again.");
        if (!controller.signal.aborted) setPage(body as unknown as WaitlistPage);
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "The waitlist could not be loaded. Try again.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [after, revision, status]);

  function refresh() {
    setCursors([null]);
    setRevision((value) => value + 1);
  }

  async function admit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (admissionInFlight.current || !pendingRestored) return;
    const count = pendingBatch?.count ?? Number(batchSize);
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      setAdmitError("Choose a whole number from 1 to 1,000.");
      return;
    }
    admissionInFlight.current = true;
    setAdmitting(true);
    setAdmitError(undefined);
    setNotice(undefined);
    try {
      // An ambiguous network failure must resolve the same admission on retry,
      // never advance to a second batch.
      const batch = pendingBatch ?? { count, requestId: crypto.randomUUID() };
      setPendingBatch(batch);
      try { sessionStorage.setItem(storageKey, JSON.stringify(batch)); } catch { setStorageAvailable(false); }
      const response = await fetch("/api/admin/waitlist/admit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(requestError(response, body, "Admission could not be confirmed. Retry this same batch."));
      if (typeof body.count !== "number") throw new Error("Admission could not be confirmed. Retry this same batch.");
      setPendingBatch(null);
      try { sessionStorage.removeItem(storageKey); } catch { setStorageAvailable(false); }
      setNotice(body.count === 0 ? "No queued entries remained to admit." : `${body.count.toLocaleString()} ${body.count === 1 ? "person" : "people"} admitted. They can sign in or recheck access now. No notification emails were sent.`);
      refresh();
    } catch (error) {
      setAdmitError(error instanceof Error ? error.message : "Admission could not be confirmed. Retry this same batch.");
    } finally {
      admissionInFlight.current = false;
      setAdmitting(false);
    }
  }

  const count = Number(batchSize);
  const validCount = Number.isInteger(count) && count >= 1 && count <= 1000;
  const admissionDisabled = !pendingRestored || (!pendingBatch && (loading || !!loadError || !page || page.queued === 0 || !validCount));

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-3 divide-x divide-line rounded-card border border-line bg-bg1">
        {[["Total", page?.total], ["Queued", page?.queued], ["Admitted", page?.admitted]].map(([label, value]) => (
          <div key={label} className="px-4 py-4 sm:px-6">
            <dt className="text-[12px] text-ink-mute">{label}</dt>
            <dd className="tnum mt-1 font-display text-[28px] text-ink">{typeof value === "number" ? value.toLocaleString() : "—"}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="admission-heading" className="rounded-card border border-line bg-bg1 p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div className="max-w-[62ch]">
            <h2 id="admission-heading" className="text-[15px] font-medium">Admit the next batch</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-mute">The oldest queued entries go first. If fewer people remain, only those people are admitted. Admission does not send an email.</p>
          </div>
          <form onSubmit={(event) => void admit(event)} className="flex flex-wrap items-end gap-3">
            <Field label="Batch size" help="1–1,000 people" className="w-36">
              <Input type="number" name="count" inputMode="numeric" min={1} max={1000} step={1} required value={batchSize} disabled={admitting || !!pendingBatch} onChange={(event) => setBatchSize(event.target.value)} />
            </Field>
            <Button type="submit" variant="primary" busy={admitting} disabled={admissionDisabled} disabledReason={!validCount ? "Choose a whole number from 1 to 1,000." : loading ? "Wait for the queue to load." : loadError ? "Refresh the queue before admitting a new batch." : "There are no queued entries to admit."} className="mb-[22px]">
              {pendingBatch ? `Retry batch of ${pendingBatch.count}` : `Admit next ${validCount ? count : "batch"}`}
            </Button>
          </form>
        </div>
        {pendingBatch && !admitting && <p className="mt-4 text-[12px] text-ink-mute">This batch is awaiting confirmation. Retrying uses the same request and will not admit a second batch.</p>}
        {!storageAvailable && pendingBatch && <p className="mt-2 text-[12px] text-ink-mute">Keep this page open until the batch is confirmed; this browser could not save the retry for a page reload.</p>}
        {admitError && <p role="alert" className="mt-4 text-[13px] text-err">{admitError}</p>}
        {notice && <p role="status" className="mt-4 text-[13px] text-ok">{notice}</p>}
      </section>

      <section aria-labelledby="queue-heading" className="overflow-hidden rounded-card border border-line bg-bg1">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
          <h2 id="queue-heading" className="text-[15px] font-medium">People on the waitlist</h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1" role="group" aria-label="Filter waitlist">
              {(["queued", "admitted"] as const).map((filter) => (
                <Button key={filter} size="sm" variant={status === filter ? "quiet" : "ghost"} aria-pressed={status === filter} disabled={admitting} disabledReason="Wait for this admission to finish." onClick={() => { setStatus(filter); setCursors([null]); }}>
                  {filter === "queued" ? "Queued" : "Admitted"}
                </Button>
              ))}
            </div>
            <Button size="sm" variant="ghost" disabled={loading || admitting} disabledReason="Wait for the current request to finish." onClick={refresh}>Refresh</Button>
          </div>
        </div>

        {loadError ? <div role="alert" className="space-y-3 p-6"><p className="text-[13px] text-err">{loadError}</p><Button size="sm" onClick={refresh}>Try loading again</Button></div>
          : loading ? <p role="status" className="p-6 text-[13px] text-ink-mute">Loading waitlist…</p>
          : page?.entries.length === 0 ? <p className="p-6 text-[13px] text-ink-mute">{after !== null ? "No more entries on this page. Go back or refresh the queue." : status === "queued" ? "The queue is empty. New requests will appear here." : "No one has been admitted yet."}</p>
          : <div className="overflow-x-auto" role="region" aria-label={`${status === "queued" ? "Queued" : "Admitted"} waitlist entries`} tabIndex={0}>
            <table className="w-full min-w-[820px] border-collapse text-left text-[13px]">
              <caption className="sr-only">Waitlist entries in queue order, with occupation and intended use.</caption>
              <thead className="border-b border-line bg-bg2 text-[11px] uppercase tracking-[0.08em] text-ink-faint"><tr>
                <th scope="col" className="w-20 px-5 py-3 font-medium">Position</th>
                <th scope="col" className="w-[26%] px-5 py-3 font-medium">Person</th>
                <th scope="col" className="px-5 py-3 font-medium">What they want to build</th>
                <th scope="col" className="w-[190px] px-5 py-3 font-medium">Status</th>
              </tr></thead>
              <tbody className="divide-y divide-line">
                {page?.entries.map((entry) => <tr key={entry.id} className="align-top">
                  <td className="tnum px-5 py-5 font-mono text-[12px] text-ink-faint">#{entry.position}</td>
                  <td className="px-5 py-5"><p className="break-all font-medium text-ink">{entry.email}</p><p className="mt-1 whitespace-pre-wrap break-words text-ink-mute">{entry.occupation}</p><p className="mt-3 text-[11px] text-ink-faint">Joined <time dateTime={entry.createdAt}>{dateLabel(entry.createdAt)}</time></p></td>
                  <td className="whitespace-pre-wrap break-words px-5 py-5 leading-relaxed text-ink-mute">{entry.useCase}</td>
                  <td className="px-5 py-5"><Chip tone={entry.status === "admitted" ? "ok" : "neutral"}>{entry.status === "admitted" ? "Admitted" : "Queued"}</Chip>{entry.admittedAt && <p className="mt-2 text-[11px] text-ink-faint"><time dateTime={entry.admittedAt}>{dateLabel(entry.admittedAt)}</time></p>}</td>
                </tr>)}
              </tbody>
            </table>
          </div>}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4 sm:px-6">
          <p className="text-[12px] text-ink-faint">Page {cursors.length} · Up to 100 entries per page</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={loading || admitting || cursors.length === 1} disabledReason={cursors.length === 1 ? "This is the first page." : "Wait for the current request to finish."} onClick={() => setCursors((values) => values.slice(0, -1))}>Previous</Button>
            <Button size="sm" disabled={loading || admitting || !!loadError || page?.nextCursor == null} disabledReason={page?.nextCursor == null ? "There are no more entries." : "Wait for the current request to finish."} onClick={() => { if (page?.nextCursor != null) setCursors((values) => [...values, page.nextCursor]); }}>Next</Button>
          </div>
        </div>
      </section>
    </div>
  );
}
