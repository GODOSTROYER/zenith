/**
 * The limits table's rows, in words, and the three enforcement sentences the
 * API's `LimitEnforcement` maps to. A limit the local runtime does not enforce
 * says so on its own row — a table that renders every limit as if it were
 * enforced is the dishonest version of this screen.
 *
 * Pure — no React. Workstream W9 (hosted R3)
 */
import { fmtDuration } from "@/lib/format";
import type { HostedLimits, LimitEnforcement } from "@/lib/hosted/contracts/types";

/** Binary units, because the limits themselves are written in them. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Thin-space (U+2009) thousands, the same separator `fmtUsd` uses for money. */
export const fmtCount = (n: number): string =>
  Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** Exactly what each enforcement value means, said the same way everywhere. */
export const ENFORCEMENT_TEXT: Record<LimitEnforcement[keyof HostedLimits], string> = {
  enforced: "Enforced here",
  provider: "Provider limit (Cloudflare) — not enforced on the local runtime",
  not_enforced: "Not enforced",
};

export interface LimitRow {
  key: keyof HostedLimits;
  label: string;
  value: string;
  enforcement: LimitEnforcement[keyof HostedLimits];
  /** an extra sentence when the number alone would mislead */
  note?: string;
}

interface LimitSpec {
  key: keyof HostedLimits;
  label: string;
  format: (n: number) => string;
  note?: string;
}

const SPECS: readonly LimitSpec[] = [
  { key: "requestsPerDay", label: "Requests a day", format: fmtCount },
  {
    key: "storageBytes",
    label: "Stored data",
    format: fmtBytes,
    note: "Counted as the logical bytes of the fields stored in this app's database, not the size of the file on disk.",
  },
  { key: "bodyBytes", label: "Largest request body", format: fmtBytes },
  { key: "buildsPerApp", label: "Builds at once, this app", format: fmtCount },
  { key: "buildsPilotWide", label: "Builds at once, all pilot apps", format: fmtCount },
  { key: "buildTimeoutMs", label: "Longest a build may run", format: fmtDuration },
  { key: "requestCpuMs", label: "Processing time a request may use", format: fmtDuration },
  { key: "outboundSubrequests", label: "Outbound calls per request", format: fmtCount },
];

/** One row per limit, in the order a builder cares about them. */
export function limitRows(limits: HostedLimits, enforcement: LimitEnforcement): LimitRow[] {
  return SPECS.map((spec) => ({
    key: spec.key,
    label: spec.label,
    value: spec.format(limits[spec.key]),
    enforcement: enforcement[spec.key] ?? "not_enforced",
    note: spec.note,
  }));
}
