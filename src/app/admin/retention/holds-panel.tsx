"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import styles from "./retention.module.css";

export interface HoldView {
  id: string;
  workspaceId: string;
  dataClass: string | null;
  classLabel: string;
  resourceRef: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
}

export interface ClassOption { value: string; label: string }

const when = (iso: string | null): string => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "no limit");

export function HoldsPanel({ holds, classes }: { holds: HoldView[]; classes: ClassOption[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const f = new FormData(form);
    const text = (k: string) => String(f.get(k) ?? "").trim();
    const time = (k: string) => (text(k) ? new Date(text(k)).toISOString() : null);
    setBusy(true);
    setMessage(undefined);
    try {
      const res = await fetch("/api/admin/ops/retention/holds", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: text("workspaceId"), reason: text("reason"), dataClass: text("dataClass") || null, resourceRef: text("resourceRef") || null, timeFrom: time("timeFrom"), timeTo: time("timeTo") }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setMessage({ ok: false, text: body?.error?.message ?? "The hold could not be placed." });
      } else {
        setMessage({ ok: true, text: "Hold placed. Archive-then-delete and pruning now skip what it covers." });
        form.reset();
        router.refresh();
      }
    } catch { setMessage({ ok: false, text: "The hold could not be placed. Check your connection and try again." }); }
    setBusy(false);
  }

  async function release(hold: HoldView) {
    if (busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const res = await fetch(`/api/admin/ops/retention/holds?id=${encodeURIComponent(hold.id)}&workspaceId=${encodeURIComponent(hold.workspaceId)}`, { method: "DELETE" });
      if (!res.ok) setMessage({ ok: false, text: "The hold could not be released." });
      else { setMessage({ ok: true, text: "Hold released. The data it covered is subject to the policy again." }); router.refresh(); }
    } catch { setMessage({ ok: false, text: "The hold could not be released. Check your connection and try again." }); }
    setBusy(false);
  }

  return (
    <>
      {holds.length === 0 ? (
        <p className={styles.empty}>No active legal holds. Nothing is protected from retention beyond the built-in rules.</p>
      ) : (
        <ul className={styles.list}>
          {holds.map((h) => (
            <li key={h.id}>
              <div>
                <strong>Workspace {h.workspaceId}</strong>
                <div className={styles.meta}>
                  {h.classLabel}{h.resourceRef ? `, resource ${h.resourceRef}` : ", every resource"}; rows recorded {when(h.timeFrom)} to {when(h.timeTo)}
                </div>
                <div className={styles.meta}>{h.reason} (placed by {h.createdBy})</div>
              </div>
              <button type="button" className={styles.button} disabled={busy} onClick={() => void release(h)}>Release hold</button>
            </li>
          ))}
        </ul>
      )}
      <form className={styles.form} onSubmit={(e) => void create(e)} aria-label="Place a legal hold">
        <label>Workspace id<input name="workspaceId" required maxLength={128} autoComplete="off" /></label>
        <label>Data class
          <select name="dataClass" defaultValue="">
            <option value="">All data classes</option>
            {classes.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label>Resource id (optional)<input name="resourceRef" maxLength={200} autoComplete="off" placeholder="job, request, resource, environment or operation" /></label>
        <label>Rows recorded from<input name="timeFrom" type="datetime-local" /></label>
        <label>Rows recorded until<input name="timeTo" type="datetime-local" /></label>
        <label>Reason<input name="reason" required maxLength={500} autoComplete="off" /></label>
        <button type="submit" className={styles.button} disabled={busy}>{busy ? "Working..." : "Place hold"}</button>
        {message ? <p className={`${styles.message} ${message.ok ? styles.ok : styles.warn}`} role="status">{message.text}</p> : null}
      </form>
    </>
  );
}
