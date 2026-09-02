/**
 * The three columns of the feed, built once per slug. Identical for every day
 * table, so the columns line up down the whole page rather than being
 * re-measured per group.
 */
import type { AuditEvent } from "@/lib/domain/types";
import { Chip, type ChipTone, type TableColumn } from "@/components/ui";
import { ActorDot } from "@/components/screens/shared";
import { EventCell } from "./event-cell";

const RESULT_TONE: Record<AuditEvent["result"], ChipTone> = {
  ok: "ok",
  error: "err",
  denied: "warn",
};

/** One vocabulary: the row chip reads like the filter that selects it. */
const RESULT_LABEL: Record<AuditEvent["result"], string> = {
  ok: "Succeeded",
  error: "Failed",
  denied: "Refused",
};

export const ACTIVITY_COLUMNS = (slug: string): TableColumn<AuditEvent>[] => [
  {
    key: "actor",
    header: "",
    headerLabel: "Who",
    width: 26,
    render: (e) => <ActorDot actor={e.actor} />,
  },
  {
    key: "action",
    header: "Action",
    render: (e) => <EventCell event={e} slug={slug} />,
  },
  {
    key: "result",
    header: "Result",
    align: "right",
    render: (e) => (
      <Chip tone={RESULT_TONE[e.result]} className="shrink-0">
        {RESULT_LABEL[e.result]}
      </Chip>
    ),
  },
];
