/**
 * The list. Newest first, one row per request, each row a single button so a
 * keyboard reaches it in one tab stop and the drawer knows what to return
 * focus to.
 */
import type { EquipmentRequest } from "../api";
import { categoryLabel, formatDay, formatMoment } from "../state";
import { PriorityBadge, StatusBadge } from "./badges";

export function RequestRow({
  record,
  selected,
  onOpen,
}: {
  record: EquipmentRequest;
  selected: boolean;
  onOpen: (record: EquipmentRequest, trigger: HTMLButtonElement) => void;
}) {
  return (
    <li className={selected ? "row is-selected" : "row"}>
      <button
        type="button"
        className="row-button"
        aria-expanded={selected}
        onClick={(event) => onOpen(record, event.currentTarget)}
      >
        <span className="row-main">
          <span className="row-title">{record.title}</span>
          <span className="row-meta">
            {categoryLabel(record.category)}
            {record.quantity > 1 ? ` \u00d7 ${record.quantity}` : ""}
            {record.requestedFor ? ` \u00b7 for ${record.requestedFor}` : ""}
          </span>
        </span>
        <span className="row-side">
          <StatusBadge status={record.status} />
          <PriorityBadge priority={record.priority} />
          <span className="row-when">
            {record.neededBy ? `Needed ${formatDay(record.neededBy)}` : "No date"}
          </span>
        </span>
        <span className="row-updated">
          Updated {formatMoment(record.updatedAt)} by {record.updatedByEmail}
        </span>
      </button>
    </li>
  );
}

export function RequestList({
  items,
  selectedId,
  filtered,
  onOpen,
}: {
  items: EquipmentRequest[];
  selectedId: string | null;
  filtered: boolean;
  onOpen: (record: EquipmentRequest, trigger: HTMLButtonElement) => void;
}) {
  if (items.length === 0) {
    return (
      <p className="empty">
        {filtered
          ? "Nothing matches those filters. Widen them to see more."
          : "No requests yet. The first one you add shows up here."}
      </p>
    );
  }
  return (
    <ul className="rows" aria-label="Equipment requests">
      {items.map((record) => (
        <RequestRow
          key={record.id}
          record={record}
          selected={record.id === selectedId}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}
