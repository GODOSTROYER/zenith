/**
 * The limits this app runs under, and — the column that matters — whether the
 * thing serving it actually enforces each one. A limit the local runtime cannot
 * enforce says so on its own row instead of implying a guarantee nobody made.
 *
 * Workstream W9 (hosted R3)
 */
import { StatusDot, type DotStatus } from "@/components/ui/status-dot";
import { Table } from "@/components/ui/table";
import type { HostedLimits, LimitEnforcement } from "@/lib/hosted/contracts";
import type { EnforcementKey } from "@/lib/client/hosted";
import { ENFORCEMENT_TEXT, limitRows, type LimitRow } from "./limits";

export interface LimitsTableProps {
  limits: HostedLimits;
  enforcement: LimitEnforcement;
  /**
   * The API's own words for each enforcement value, shown verbatim when it
   * sends them. The defaults below are used only where it does not.
   */
  labels?: Record<EnforcementKey, string>;
  className?: string;
}

/** Green only where a limit is genuinely applied here; the rest are neutral facts. */
const DOT: Record<LimitRow["enforcement"], DotStatus> = {
  enforced: "ok",
  provider: "info",
  not_enforced: "idle",
};

export function LimitsTable({ limits, enforcement, labels, className }: LimitsTableProps) {
  const rows = limitRows(limits, enforcement);
  const wording = (row: LimitRow): string =>
    labels?.[row.enforcement] ?? ENFORCEMENT_TEXT[row.enforcement];
  return (
    <Table<LimitRow>
      className={className}
      caption="Limits for this app and where each one is applied"
      rows={rows}
      rowKey={(row) => row.key}
      empty={
        <Table.Empty>
          <p>This response carried no limits.</p>
        </Table.Empty>
      }
      columns={[
        {
          key: "label",
          header: "Limit",
          render: (row) => (
            <div className="min-w-[180px]">
              <p className="text-[13px] text-ink">{row.label}</p>
              {row.note && (
                <p className="mt-0.5 max-w-[52ch] text-[12px] text-ink-mute">{row.note}</p>
              )}
            </div>
          ),
        },
        {
          key: "value",
          header: "Allowed",
          width: 140,
          render: (row) => <span className="tnum text-[13px] text-ink">{row.value}</span>,
        },
        {
          key: "enforcement",
          header: "Where it applies",
          width: 320,
          render: (row) => (
            <span className="flex items-start gap-2 text-[12.5px] text-ink-mute">
              <StatusDot status={DOT[row.enforcement]} label={wording(row)} className="mt-1.5" />
              <span className="min-w-[180px]">{wording(row)}</span>
            </span>
          ),
        },
      ]}
    />
  );
}
