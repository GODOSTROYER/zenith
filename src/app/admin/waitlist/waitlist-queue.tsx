"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Chip } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import type { WaitlistEntry, WaitlistPage, WaitlistAdmissionSelection, WaitlistAdmissionPreview, WaitlistAdmissionBatch } from "@/lib/waitlist/types";
import styles from "../admin.module.css";

interface PendingApproval { previewId: string; requestId: string; count: number; mode: WaitlistAdmissionSelection["mode"] }
interface LegacyApproval { requestId: string; count: number }
interface HistoryDetail { batch: WaitlistAdmissionBatch; entries: WaitlistEntry[]; nextOffset: number | null }
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  try { return await response.json(); } catch { return {}; }
}
function requestError(response: Response, body: Record<string, unknown>, fallback: string): string {
  if (response.status === 401) return "Your session has expired. Sign in again to continue.";
  if (response.status === 403) return "This account does not have owner access.";
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error === "object" && "message" in body.error && typeof body.error.message === "string") return body.error.message;
  return fallback;
}
function dateLabel(value: string, short = false): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", ...(short ? {} : { timeStyle: "short" as const }) });
}
function people(count: number) { return `${count.toLocaleString()} ${count === 1 ? "person" : "people"}`; }
function modeLabel(mode: WaitlistAdmissionSelection["mode"]) { return mode === "all" ? "Entire queue" : mode === "next" ? "Next in queue" : "Selected people"; }
function validPending(value: unknown): value is PendingApproval {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PendingApproval>;
  return typeof item.previewId === "string" && UUID.test(item.previewId) && typeof item.requestId === "string" && UUID.test(item.requestId) && typeof item.count === "number" && Number.isInteger(item.count) && item.count >= 0 && ["all", "next", "selected"].includes(item.mode ?? "");
}

export function WaitlistQueue({ operatorId }: { operatorId: string }) {
  const [status, setStatus] = useState<WaitlistEntry["status"] | "all">("queued");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<Array<number | null>>([null]);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<WaitlistPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<WaitlistEntry | null>(null);
  const [batchSize, setBatchSize] = useState("25");
  const [preview, setPreview] = useState<WaitlistAdmissionPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [legacyPending, setLegacyPending] = useState<LegacyApproval | null>(null);
  const [checkingLegacy, setCheckingLegacy] = useState(false);
  const [restored, setRestored] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [admitting, setAdmitting] = useState(false);
  const [admitError, setAdmitError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [history, setHistory] = useState<WaitlistAdmissionBatch[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string>();
  const [historyDetail, setHistoryDetail] = useState<HistoryDetail | null>(null);
  const [historyRequest, setHistoryRequest] = useState<string | null>(null);
  const admissionInFlight = useRef(false);
  const previewInFlight = useRef(false);
  const historyInFlight = useRef(false);
  const legacyInFlight = useRef(false);
  const after = cursors[cursors.length - 1];
  const storageKey = `zenith:waitlist:pending-approval:${operatorId}`;
  const legacyStorageKey = `zenith:waitlist:pending-admission:${operatorId}`;

  useEffect(() => {
    setPending(null);
    setLegacyPending(null);
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) { const parsed: unknown = JSON.parse(saved); if (validPending(parsed)) setPending(parsed); }
      const legacySaved = sessionStorage.getItem(legacyStorageKey);
      if (legacySaved) {
        const legacy: Partial<LegacyApproval> = JSON.parse(legacySaved);
        if (legacy && typeof legacy.requestId === "string" && UUID.test(legacy.requestId) && typeof legacy.count === "number" && Number.isInteger(legacy.count) && legacy.count >= 1 && legacy.count <= 1000) setLegacyPending(legacy as LegacyApproval);
      }
    } catch { setStorageAvailable(false); }
    setRestored(true);
  }, [storageKey, legacyStorageKey]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(undefined);
    const params = new URLSearchParams({ limit: "25" });
    if (status !== "all") params.set("status", status);
    if (after !== null) params.set("after", String(after));
    if (search) params.set("q", search);
    void (async () => {
      try {
        const response = await fetch(`/api/admin/waitlist?${params}`, { cache: "no-store", signal: controller.signal });
        const body = await responseBody(response);
        if (!response.ok) throw new Error(requestError(response, body, "The waitlist could not be loaded. Try again."));
        if (!Array.isArray(body.entries)) throw new Error("The waitlist response was incomplete. Try again.");
        if (!controller.signal.aborted) setPage(body as unknown as WaitlistPage);
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "The waitlist could not be loaded.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [after, revision, status, search]);

  useEffect(() => {
    const controller = new AbortController();
    setHistoryLoading(true);
    setHistoryError(undefined);
    void (async () => {
      try {
        const response = await fetch("/api/admin/waitlist/history?limit=50", { cache: "no-store", signal: controller.signal });
        const body = await responseBody(response);
        if (!response.ok) throw new Error(requestError(response, body, "Approval history could not be loaded."));
        if (!Array.isArray(body.batches)) throw new Error("Approval history was incomplete.");
        if (!controller.signal.aborted) setHistory(body.batches as WaitlistAdmissionBatch[]);
      } catch (error) { if (!controller.signal.aborted) setHistoryError(error instanceof Error ? error.message : "Approval history could not be loaded."); }
      finally { if (!controller.signal.aborted) setHistoryLoading(false); }
    })();
    return () => controller.abort();
  }, [revision]);

  function refresh() { setCursors([null]); setRevision(value => value + 1); }
  function clearPending() {
    setPending(null);
    try { sessionStorage.removeItem(storageKey); } catch { setStorageAvailable(false); }
  }
  function changeFilter(value: typeof status) { setStatus(value); setCursors([null]); setSelected(new Set()); }
  function runSearch(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setSearch(query.trim()); setCursors([null]); setSelected(new Set()); }
  function toggleEntry(id: string, checked: boolean) {
    setSelected(current => { const next = new Set(current); if (checked && next.size < 1000) next.add(id); else next.delete(id); return next; });
  }

  async function prepare(selection: WaitlistAdmissionSelection) {
    if (previewInFlight.current || admissionInFlight.current || pending || legacyPending || !restored) return;
    previewInFlight.current = true;
    setPreviewing(true); setAdmitError(undefined); setNotice(undefined);
    try {
      const response = await fetch("/api/admin/waitlist/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(selection) });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(requestError(response, body, "This approval could not be prepared. Please try again."));
      if (typeof body.id !== "string" || typeof body.count !== "number" || !Array.isArray(body.entries)) throw new Error("The approval preview was incomplete. Please try again.");
      setReview(null);
      setPreview(body as unknown as WaitlistAdmissionPreview);
    } catch (error) { setAdmitError(error instanceof Error ? error.message : "This approval could not be prepared."); }
    finally { previewInFlight.current = false; setPreviewing(false); }
  }

  async function approve() {
    if (admissionInFlight.current || (!preview && !pending) || !restored) return;
    const batch = pending ?? { previewId: preview!.id, requestId: crypto.randomUUID(), count: preview!.count, mode: preview!.mode };
    admissionInFlight.current = true;
    setAdmitting(true); setAdmitError(undefined); setNotice(undefined); setPending(batch);
    try {
      // Save the request before sending: a lost response must retry this exact snapshot.
      try { sessionStorage.setItem(storageKey, JSON.stringify(batch)); } catch { setStorageAvailable(false); }
      const response = await fetch("/api/admin/waitlist/admit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previewId: batch.previewId, requestId: batch.requestId }) });
      const body = await responseBody(response);
      if (!response.ok) {
        // The API's 409 responses are definitive guard rejections. Return to a
        // fresh review; never replace the key and re-submit automatically.
        if (response.status === 409) { clearPending(); setPreview(null); refresh(); }
        throw new Error(requestError(response, body, "Approval could not be confirmed. Retry this same approval."));
      }
      if (body.requestId !== batch.requestId || typeof body.count !== "number" || !Number.isInteger(body.count) || body.count < 0 || body.count > batch.count) throw new Error("Approval could not be confirmed. Retry this same approval.");
      clearPending(); setPreview(null); setSelected(new Set()); setReview(null);
      setNotice(`${people(body.count)} approved.${body.count < batch.count ? ` ${people(batch.count - body.count)} had already been approved.` : ""} They can sign in with Google using the same email. No email was sent automatically.`);
      refresh();
    } catch (error) { setAdmitError(error instanceof Error ? error.message : "Approval could not be confirmed. Retry this same approval."); }
    finally { admissionInFlight.current = false; setAdmitting(false); }
  }

  async function showHistory(batch: WaitlistAdmissionBatch, offset = 0) {
    if (historyInFlight.current) return;
    historyInFlight.current = true;
    setHistoryRequest(batch.requestId); setHistoryError(undefined);
    try {
      const response = await fetch(`/api/admin/waitlist/history/${encodeURIComponent(batch.requestId)}?offset=${offset}&limit=100`, { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(requestError(response, body, "The people in this approval could not be loaded."));
      if (!Array.isArray(body.entries) || !body.batch) throw new Error("This approval record was incomplete.");
      const detail = body as unknown as HistoryDetail;
      setHistoryDetail(current => offset > 0 && current?.batch.requestId === batch.requestId ? { ...detail, entries: [...current.entries, ...detail.entries] } : detail);
    } catch (error) { setHistoryError(error instanceof Error ? error.message : "This approval could not be loaded."); }
    finally { historyInFlight.current = false; setHistoryRequest(null); }
  }

  async function checkLegacyApproval() {
    if (!legacyPending || legacyInFlight.current) return;
    legacyInFlight.current = true;
    setCheckingLegacy(true); setAdmitError(undefined);
    try {
      // Older consoles stored a FIFO request. Resolve its receipt read-only;
      // never replay a potentially large legacy admission just to recover UI.
      const response = await fetch(`/api/admin/waitlist/history/${encodeURIComponent(legacyPending.requestId)}?offset=0&limit=100`, { cache: "no-store" });
      const body = await responseBody(response);
      if (response.status === 404) setNotice("No completed approval record was found for the earlier request. Review the current queue before starting a new approval.");
      else {
        if (!response.ok) throw new Error(requestError(response, body, "The earlier approval could not be checked. Try again."));
        if (!body.batch || !Array.isArray(body.entries)) throw new Error("The earlier approval record was incomplete. Try again.");
        const detail = body as unknown as HistoryDetail;
        setHistoryDetail(detail);
        setNotice(`Earlier approval confirmed: ${people(detail.batch.admittedCount)} approved. No email was sent automatically.`);
      }
      setLegacyPending(null);
      try { sessionStorage.removeItem(legacyStorageKey); } catch { setStorageAvailable(false); }
      refresh();
    } catch (error) { setAdmitError(error instanceof Error ? error.message : "The earlier approval could not be checked."); }
    finally { legacyInFlight.current = false; setCheckingLegacy(false); }
  }

  const locked = admitting || previewing || !!pending || !!legacyPending || !!preview || !restored;
  const unavailable = locked || loading || !!loadError || !page || page.queued === 0;
  const disabledReason = legacyPending ? "Check the earlier approval record before starting another." : pending ? "Confirm the pending approval before starting another." : locked ? "Finish the current review first." : loading ? "Wait for the queue to load." : loadError ? "Reload the queue before approving people." : "No people are waiting for approval.";
  const queuedOnPage = page?.entries.filter(entry => entry.status === "queued") ?? [];
  const allPageSelected = queuedOnPage.length > 0 && queuedOnPage.every(entry => selected.has(entry.id));
  const count = Number(batchSize);
  const validCount = Number.isInteger(count) && count >= 1 && count <= 1000;
  const matched = page?.matched ?? (status === "queued" ? page?.queued : status === "admitted" ? page?.admitted : page?.total);

  return (
    <div className={styles.queue}>
      <dl id="overview" aria-label="Waitlist overview" className={styles.stats}>
        {[["Total signups", page?.total, "Everyone who joined"], ["Awaiting approval", page?.queued, "Ready for your review"], ["Approved", page?.admitted, "Access has been granted"]].map(([label, value, note]) => <div className={styles.stat} key={label}><dt>{label}</dt><dd>{typeof value === "number" ? value.toLocaleString() : "—"}</dd><p className={styles.statNote}>{note}</p></div>)}
      </dl>

      {notice && <div role="status" className={`${styles.message} ${styles.success}`}><p>{notice}</p><Button size="sm" variant="ghost" onClick={() => setNotice(undefined)}>Dismiss</Button></div>}
      {admitError && !preview && <div role="alert" className={`${styles.message} ${styles.error}`}><p>{admitError}</p></div>}
      {legacyPending && <div className={`${styles.message} ${styles.pending}`}><div><p>An earlier approval of up to {people(legacyPending.count)} needs checking.</p><p className={styles.muted}>Check its saved record before starting another approval.</p></div><Button busy={checkingLegacy} onClick={() => void checkLegacyApproval()}>Check earlier approval</Button></div>}
      {pending && !preview && <div className={`${styles.message} ${styles.pending}`}><div><p>Approval of {people(pending.count)} is awaiting confirmation.</p><p className={styles.muted}>Retrying uses the same saved group and cannot approve a second batch.</p>{!storageAvailable && <p className={styles.muted}>Keep this page open until confirmed; this browser could not save the retry.</p>}</div><Button variant="primary" busy={admitting} onClick={() => void approve()}>Retry same approval</Button></div>}

      <section id="waitlist" aria-labelledby="queue-heading" className={styles.section}>
        <div className={styles.sectionHeading}><div><h2 id="queue-heading">Waitlist</h2><p>Read their plans. Make room for what comes next.</p></div><Button size="sm" variant="ghost" icon={<RefreshCw size={14} aria-hidden="true" />} disabled={loading || admitting} disabledReason="Wait for the current request to finish." onClick={refresh}>Refresh</Button></div>
        <div className={styles.toolbar}>
          <div className={styles.filters} role="group" aria-label="Filter waitlist">{(["queued", "admitted", "all"] as const).map(filter => <Button key={filter} size="sm" variant={status === filter ? "quiet" : "ghost"} aria-pressed={status === filter} disabled={locked} disabledReason={disabledReason} onClick={() => changeFilter(filter)}>{filter === "queued" ? "Awaiting approval" : filter === "admitted" ? "Approved" : "Everyone"}</Button>)}</div>
          <form className={styles.search} onSubmit={runSearch}><Input aria-label="Search waitlist" placeholder="Search name, email, profession…" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} prefix={<Search size={14} aria-hidden="true" />} disabled={locked} /><Button type="submit" size="sm" disabled={locked} disabledReason={disabledReason}>Search</Button></form>
        </div>
        <div className={styles.admissionBar}>
          <div className={styles.selectionActions}><span className={styles.selectionCount}>{selected.size} selected</span><Button size="sm" variant={selected.size ? "primary" : "quiet"} disabled={unavailable || selected.size === 0} disabledReason={selected.size === 0 ? "Select people using the checkboxes below." : disabledReason} onClick={() => void prepare({ mode: "selected", entryIds: [...selected] })}>Approve selected</Button>{selected.size > 0 && <Button size="sm" variant="ghost" disabled={locked} disabledReason={disabledReason} onClick={() => setSelected(new Set())}>Clear</Button>}</div>
          <div className={styles.batchActions}><Button size="sm" disabled={unavailable} disabledReason={disabledReason} onClick={() => void prepare({ mode: "next", count: 50 })}>Approve top 50</Button><form className={styles.batchForm} onSubmit={event => { event.preventDefault(); if (validCount) void prepare({ mode: "next", count }); }}><Input aria-label="Custom batch size" title="A whole number from 1 to 1,000" type="number" inputMode="numeric" min={1} max={1000} step={1} required value={batchSize} disabled={locked} onChange={event => setBatchSize(event.target.value)} /><Button type="submit" size="sm" disabled={unavailable || !validCount} disabledReason={!validCount ? "Choose a whole number from 1 to 1,000." : disabledReason}>Approve next</Button></form><Button size="sm" disabled={unavailable} disabledReason={disabledReason} onClick={() => void prepare({ mode: "all" })}>Approve all</Button></div>
        </div>
        {loadError ? <div role="alert" className={styles.empty}><h3>Unable to load the waitlist</h3><p>{loadError}</p><Button size="sm" onClick={refresh}>Try again</Button></div>
          : loading ? <div className={styles.empty} role="status"><p>Loading waitlist…</p></div>
          : page?.entries.length === 0 ? <div className={styles.empty}><h3>{search ? "No matching people" : status === "admitted" ? "No approvals yet" : "You’re all caught up"}</h3><p>{search ? "Try a different name, email, profession, or feature." : after !== null ? "There are no more people on this page. Return to the previous page." : status === "admitted" ? "People you approve will appear here." : "New waitlist requests will appear here."}</p></div>
          : <div className={styles.tableWrap} role="region" aria-label="Waitlist people" tabIndex={0}><table className={styles.table}>
            <caption className="sr-only">Waitlist in signup order. Open Review to see every answer before approving.</caption>
            <thead><tr><th className={styles.checkboxCell} scope="col"><Checkbox label={<span className="sr-only">Select queued people on this page</span>} checked={allPageSelected} disabled={locked || queuedOnPage.length === 0} disabledReason={disabledReason} onChange={checked => setSelected(current => { const next = new Set(current); queuedOnPage.forEach(entry => { if (checked && next.size < 1000) next.add(entry.id); else if (!checked) next.delete(entry.id); }); return next; })} /></th><th scope="col">Person</th><th scope="col" className={styles.features}>What they want to build</th><th scope="col" className={styles.joined}>Joined</th><th scope="col"><span className="sr-only">Status and review</span></th></tr></thead>
            <tbody>{page?.entries.map(entry => <tr key={entry.id}>
              <td className={styles.checkboxCell}>{entry.status === "queued" && <Checkbox label={<span className="sr-only">Select {entry.email}</span>} checked={selected.has(entry.id)} disabled={locked || (!selected.has(entry.id) && selected.size >= 1000)} disabledReason={selected.size >= 1000 ? "Approve your current selection before selecting more than 1,000 people." : disabledReason} onChange={checked => toggleEntry(entry.id, checked)} />}</td>
              <td className={styles.person}><button type="button" onClick={() => setReview(entry)} aria-label={`Review ${entry.name || entry.email}`}>{entry.name || entry.email}</button>{entry.name && <p>{entry.email}</p>}<p className={styles.occupation}>{entry.occupation || "Profession not provided"}</p></td>
              <td className={styles.features}><p>{entry.features.length ? entry.features.join(" · ") : "No feature interests provided"}</p>{entry.useCase && <p className={styles.useCase}>{entry.useCase}</p>}</td>
              <td className={styles.joined}><time dateTime={entry.createdAt}>{dateLabel(entry.createdAt, true)}</time><span>#{entry.position}</span></td>
              <td><div className={styles.rowActions}>{entry.status === "admitted" && <Chip tone="ok">Approved</Chip>}<Button size="sm" variant="ghost" onClick={() => setReview(entry)} aria-label={`Open details for ${entry.email}`}>Review</Button></div></td>
            </tr>)}</tbody>
          </table></div>}
        <div className={styles.pagination}><p>Page {cursors.length} · {matched?.toLocaleString() ?? "—"} {search ? "matching" : ""} people · 25 per page</p><div><Button size="sm" icon={<ChevronLeft size={14} aria-hidden="true" />} disabled={loading || locked || cursors.length === 1} disabledReason={cursors.length === 1 ? "This is the first page." : disabledReason} onClick={() => setCursors(values => values.slice(0, -1))}>Previous</Button><Button size="sm" disabled={loading || locked || !!loadError || page?.nextCursor == null} disabledReason={page?.nextCursor == null ? "There are no more people to show." : disabledReason} onClick={() => { if (page?.nextCursor != null) setCursors(values => [...values, page.nextCursor]); }}>Next <ChevronRight size={14} aria-hidden="true" /></Button></div></div>
        <p className={`${styles.muted} mt-3`}>Top 50, custom batches, and approve all use the whole queue in signup order, regardless of search filters. Every action opens a review first.</p>
      </section>

      <section id="approval-history" aria-labelledby="history-heading" className={styles.section}>
        <div className={styles.sectionHeading}><div><h2 id="history-heading">Approval history</h2><p>Your recent approvals and the people included.</p></div><span>Latest 50 batches</span></div>
        {historyError && <div role="alert" className={`${styles.message} ${styles.error}`}><p>{historyError}</p><Button size="sm" onClick={() => setRevision(value => value + 1)}>Reload history</Button></div>}
        {historyLoading ? <p className={styles.muted} role="status">Loading approval history…</p> : history.length === 0 ? <div className={styles.empty}><h3>A fresh start</h3><p>Your first approval will be recorded here with its time and the people included.</p></div> : <ol className={styles.history}>{history.map(batch => <li key={batch.requestId} className={styles.historyRow}><span className={styles.historyIcon}><Check size={15} aria-hidden="true" /></span><div className={styles.historyBody}><strong>{people(batch.admittedCount)} approved</strong><p>{modeLabel(batch.mode)} · {people(batch.requestedCount)} reviewed</p><Button size="sm" variant="ghost" className="mt-2" busy={historyRequest === batch.requestId} disabled={!!historyRequest && historyRequest !== batch.requestId} disabledReason="Wait for the current approval record to load." onClick={() => void showHistory(batch)}>View people</Button></div><time dateTime={batch.createdAt}>{dateLabel(batch.createdAt)}</time></li>)}</ol>}
      </section>

      <Drawer open={!!review} onClose={() => setReview(null)} title={review?.name || "Waitlist request"} description={review?.email} className={styles.theme} footer={review && <div className={styles.drawerFooter}><Button onClick={() => setReview(null)}>Close</Button>{review.status === "queued" ? <Button variant="primary" busy={previewing} disabled={unavailable} disabledReason={disabledReason} onClick={() => void prepare({ mode: "selected", entryIds: [review.id] })}>Approve this person</Button> : <Chip tone="ok">Access approved</Chip>}</div>}>
        {review && <><div className={styles.detailHeader}><span>Queue position #{review.position}</span><Chip tone={review.status === "admitted" ? "ok" : "neutral"}>{review.status === "admitted" ? "Approved" : "Awaiting approval"}</Chip></div><dl className={`${styles.details} mt-5`}>
          <div><dt>Email address</dt><dd>{review.email}</dd></div><div><dt>Name</dt><dd>{review.name || "Not provided"}</dd></div><div><dt>Profession</dt><dd>{review.occupation || "Not provided"}</dd></div><div><dt>Feature interests</dt><dd>{review.features.length ? <ul>{review.features.map(feature => <li key={feature}><Chip>{feature}</Chip></li>)}</ul> : "Not provided"}</dd></div><div><dt>What they want to build</dt><dd>{review.useCase || "Not provided"}</dd></div><div><dt>Joined the waitlist</dt><dd><time dateTime={review.createdAt}>{dateLabel(review.createdAt)}</time></dd></div>{review.admittedAt && <div><dt>Approved</dt><dd><time dateTime={review.admittedAt}>{dateLabel(review.admittedAt)}</time></dd></div>}
        </dl>{admitError && <p role="alert" className={`${styles.error} mt-5`}>{admitError}</p>}</>}
      </Drawer>

      <Dialog open={!!preview} onClose={() => { if (!admitting && !pending) { setPreview(null); setAdmitError(undefined); } }} title={`Approve ${people(preview?.count ?? 0)}?`} description="Review the captured group before granting early access." width={580} className={styles.theme} footer={<><Button disabled={admitting || !!pending} disabledReason="Resolve this approval with the same request before starting another." onClick={() => { setPreview(null); setAdmitError(undefined); }}>Cancel</Button><Button variant="primary" busy={admitting} disabled={!preview || preview.count === 0} disabledReason="No queued people remain in this group." onClick={() => void approve()}>{pending ? "Retry same approval" : `Confirm ${people(preview?.count ?? 0)}`}</Button></>}>
        {preview && <><div className={styles.previewSummary}><strong>{modeLabel(preview.mode)} · {people(preview.count)}</strong><p>This exact group was captured at {dateLabel(preview.createdAt)}. Later signups will not be included. Already approved people are skipped.</p></div><p className={styles.muted}>Approved people can sign in with Google using the same email. No email is sent automatically.</p>{preview.entries.length > 0 && <ul className={styles.previewList}>{preview.entries.map(entry => <li key={entry.id}><div><p>{entry.name || entry.email}</p>{entry.name && <p>{entry.email}</p>}{entry.occupation && <p>{entry.occupation}</p>}</div><span>#{entry.position}</span></li>)}</ul>}{preview.count > preview.entries.length && <p className={styles.muted}>Showing the first {preview.entries.length} of {people(preview.count)} in this group. Confirming approves the full captured group.</p>}<p className={styles.muted}>Review expires {dateLabel(preview.expiresAt)}.</p>{pending && <p className={`${styles.muted} mt-3`}>This approval is awaiting confirmation. Retry uses the same group and request.</p>}{!storageAvailable && pending && <p className={`${styles.muted} mt-3`}>Keep this page open until confirmed; this browser could not save the retry.</p>}{admitError && <p role="alert" className={`${styles.error} mt-3`}>{admitError}</p>}</>}
      </Dialog>

      <Dialog open={!!historyDetail} onClose={() => { if (!historyRequest) setHistoryDetail(null); }} title="People in this approval" description={historyDetail ? `${people(historyDetail.batch.admittedCount)} approved on ${dateLabel(historyDetail.batch.createdAt)}` : undefined} width={580} className={styles.theme} footer={<><Button disabled={!!historyRequest} disabledReason="Wait for the next page of people to load." onClick={() => setHistoryDetail(null)}>Close</Button>{historyDetail?.nextOffset != null && <Button busy={!!historyRequest} onClick={() => void showHistory(historyDetail.batch, historyDetail.nextOffset!)}>Load more people</Button>}</>}>
        {historyDetail && <><p className={styles.muted}>{modeLabel(historyDetail.batch.mode)} · {people(historyDetail.batch.requestedCount)} reviewed. This record shows the people whose access changed.</p><ul className={styles.previewList}>{historyDetail.entries.map(entry => <li key={entry.id}><div><p>{entry.name || entry.email}</p>{entry.name && <p>{entry.email}</p>}{entry.occupation && <p>{entry.occupation}</p>}</div><span>#{entry.position}</span></li>)}</ul><p className={styles.muted}>Showing {historyDetail.entries.length.toLocaleString()} of {people(historyDetail.batch.admittedCount)}.</p><p className={styles.muted}>Reference: {historyDetail.batch.requestId}</p>{historyError && <p role="alert" className={`${styles.error} mt-3`}>{historyError}</p>}</>}
      </Dialog>
    </div>
  );
}
