/**
 * Status and category filters. Both are plain selects, both reset the list,
 * and "Any" is a real option rather than a cleared field.
 *
 * Workstream W4 (hosted R3)
 */
import {
  REQUEST_CATEGORIES,
  REQUEST_STATUSES,
  type RequestCategory,
  type RequestStatus,
} from "../api";
import { categoryLabel, statusLabel } from "../state";
import type { Filters } from "../use-tracker";

export function FilterBar({
  filters,
  onChange,
  summary,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  summary: string;
}) {
  return (
    <div className="filters">
      <div className="filter">
        <label className="filter-label" htmlFor="filter-status">
          Status
        </label>
        <select
          className="control control-compact"
          id="filter-status"
          value={filters.status ?? ""}
          onChange={(event) =>
            onChange({
              ...filters,
              status: event.target.value ? (event.target.value as RequestStatus) : undefined,
            })
          }
        >
          <option value="">Any status</option>
          {REQUEST_STATUSES.map((status) => (
            <option key={status} value={status}>
              {statusLabel(status)}
            </option>
          ))}
        </select>
      </div>

      <div className="filter">
        <label className="filter-label" htmlFor="filter-category">
          Category
        </label>
        <select
          className="control control-compact"
          id="filter-category"
          value={filters.category ?? ""}
          onChange={(event) =>
            onChange({
              ...filters,
              category: event.target.value
                ? (event.target.value as RequestCategory)
                : undefined,
            })
          }
        >
          <option value="">Any category</option>
          {REQUEST_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {categoryLabel(category)}
            </option>
          ))}
        </select>
      </div>

      <p className="filter-summary">{summary}</p>
    </div>
  );
}
