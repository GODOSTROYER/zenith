import type { Metadata } from "next";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth/session";
import { opsAdminIds } from "@/lib/ops/config";
import { platformConfigured } from "@/lib/ops/runtime";
import { buildSloReport, type ObjectiveReport, type ObjectiveState, type SloReport } from "@/lib/slo/report";
import styles from "./slo.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Service objectives · Zenith", robots: { index: false, follow: false } };

const STATE_TEXT: Record<ObjectiveState, string> = {
  meeting: "Meeting target",
  breaching: "Below target",
  no_data: "No data yet",
  met: "Met in last measurement",
  missed: "Missed in last measurement",
  not_measured: "Not measured yet",
  unavailable: "Unavailable",
};
const STATE_TONE: Record<ObjectiveState, "good" | "bad" | "idle"> = { meeting: "good", met: "good", breaching: "bad", missed: "bad", no_data: "idle", not_measured: "idle", unavailable: "idle" };

function valueText(o: ObjectiveReport): string {
  if (o.current === null) return "No measurement";
  if (o.kind === "ratio" || o.kind === "latency_ratio") return `${(o.current * 100).toFixed(3)}%`;
  if (o.kind === "capacity") return `${o.current.toFixed(1)} requests/s`;
  return `${Math.round(o.current)} s`;
}

function budgetText(o: ObjectiveReport): string {
  const r = o.budget?.remainingFraction;
  if (r === null || r === undefined) return "No data";
  return r < 0 ? `Overspent by ${Math.round(-r * 100)}%` : `${Math.round(r * 100)}% left`;
}

function Row({ o }: { o: ObjectiveReport }) {
  const firing = o.alerts?.filter((a) => a.firing) ?? [];
  const tone = STATE_TONE[o.state];
  return (
    <tr>
      <th scope="row">
        <span className={styles.name}>{o.title}</span>
        <span className={styles.sli}>{o.sli}</span>
        {o.note ? <span className={styles.note}>{o.note}</span> : null}
      </th>
      <td>{o.targetText}<span className={styles.provisional}>{o.label}</span></td>
      <td className={styles.num}>{valueText(o)}{o.processP95Seconds != null ? <span className={styles.sub}>This process p95 about {Math.round(o.processP95Seconds * 1000)} ms</span> : null}</td>
      <td><span className={`${styles.state} ${styles[tone]}`}>{STATE_TEXT[o.state]}</span></td>
      <td>{o.budget ? budgetText(o) : "Not applicable"}{firing.length ? <span className={styles.burn}>Burning fast: {firing.map((a) => a.name).join(", ")}</span> : null}</td>
    </tr>
  );
}

function Report({ report }: { report: SloReport }) {
  return (
    <>
      <p className={styles.banner} role="note">
        <strong>{report.label}.</strong> These targets are engineering defaults awaiting a business decision ({report.approval.pendingDecision}). Nobody has
        approved them, and they are not commitments to customers.
      </p>
      <p className={styles.meta}>Definitions {report.definitionVersion}. Error budget over {report.budgetWindowDays} days. Generated {report.generatedAt}.</p>
      {report.restoreMilestones ? <section aria-label="Restore milestones"><h2>Restore completion evidence</h2>
        <p>Database completion: {report.restoreMilestones.database[0] ? `${report.restoreMilestones.database[0].value} seconds after restore start` : "Not measured"}.</p>
        <p>First healthy application readiness: {report.restoreMilestones.application[0] ? `${report.restoreMilestones.application[0].value} seconds after restore start` : "Not measured"}. RTO uses application readiness.</p>
      </section> : null}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead><tr><th scope="col">Objective</th><th scope="col">Provisional target</th><th scope="col">Current</th><th scope="col">Status</th><th scope="col">Error budget</th></tr></thead>
          <tbody>{report.objectives.map((o) => <Row key={o.id} o={o} />)}</tbody>
        </table>
      </div>
    </>
  );
}

export default async function SloPage() {
  const user = await getSessionUser();
  const allowed = user !== null && opsAdminIds().has(user.id);
  let report: SloReport | null = null;
  let problem: string | null = null;
  if (allowed) {
    if (!platformConfigured()) problem = "The platform control store is not configured on this host, so no indicator can be read.";
    else {
      try {
        const { platformDb } = await import("@/lib/controlplane/db");
        report = await buildSloReport(await platformDb());
      } catch { problem = "The platform control store is unavailable. Try again shortly."; }
    }
  }
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/admin" className={styles.back}>Back to administration</Link>
        <h1>Service objectives</h1>
      </header>
      {!allowed ? <p className={styles.banner} role="alert">Platform operator access is required. Ask an operator to add your user id to ZENITH_OPS_ADMIN_IDS.</p> : null}
      {problem ? <p className={styles.banner} role="alert">{problem}</p> : null}
      {report ? <Report report={report} /> : null}
    </main>
  );
}
