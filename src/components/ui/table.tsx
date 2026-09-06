"use client";
/**
 * The one table in Zenith.ai.
 *
 * A real `<table>`, because a list of records read down a column is a table and
 * screen readers, "find in page" and browser zoom all know what to do with one.
 * Everything optional is off by default: a table with columns and rows is just
 * a table, and only a caller that asks for sorting, selection or keyboard row
 * navigation pays for them.
 *
 * Two things are not optional. Every table has a caption (sr-only unless asked
 * for) — an unlabelled table is an unlabelled region. And the scroll container
 * is the table's own wrapper, so a wide table scrolls sideways inside itself
 * instead of pushing the page sideways.
 */
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cx } from "@/lib/format";

export type SortDirection = "asc" | "desc";

export interface SortState {
  key: string;
  dir: SortDirection;
}

export interface TableColumn<T> {
  key: string;
  header: ReactNode;
  /** sr-only header text — required when `header` is an icon or empty */
  headerLabel?: string;
  align?: "left" | "center" | "right";
  /** any CSS width; a number is px */
  width?: string | number;
  sortable?: boolean;
  /**
   * What this column sorts on. Present: the table sorts the rows itself.
   * Absent on a sortable column: the caller sorts (server paging, a custom
   * comparator) and only the header state is managed here.
   */
  sortValue?: (row: T) => string | number;
  render: (row: T, index: number) => ReactNode;
  /** hide from small viewports without dropping it from the DOM order */
  className?: string;
}

export interface TableProps<T> {
  /** what this table is a table of — always announced, drawn only if asked */
  caption: string;
  captionVisible?: boolean;
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** controlled sort; pair with `onSortChange` */
  sort?: SortState;
  /** uncontrolled starting sort */
  defaultSort?: SortState;
  onSortChange?: (sort: SortState) => void;
  /**
   * Makes rows activatable: `aria-current="true"` on the selected row, roving
   * tab stop, ↑/↓/Home/End between rows, Enter/Space to pick. Omit it and rows
   * stay plain — whatever controls the cells hold keep their own tab order.
   */
  onSelectRow?: (row: T) => void;
  selectedKey?: string;
  rowClassName?: (row: T) => string | undefined;
  /** default true; needs a scroll container to have anything to stick to */
  stickyHeader?: boolean;
  /** vertical scroll cap for the wrapper; a number is px */
  maxHeight?: number | string;
  /** rendered in place of the rows when there are none — see `Table.Empty` */
  empty?: ReactNode;
  className?: string;
  /** on the scrolling wrapper */
  wrapperClassName?: string;
}

const ALIGN = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
} as const;

const ARIA_SORT = { asc: "ascending", desc: "descending" } as const;

function compare(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

const px = (v: string | number | undefined) => (typeof v === "number" ? `${v}px` : v);

/**
 * Sorted, selectable, scrollable table. Presentational: it never fetches and
 * never owns the rows, so a screen that pages from a cursor keeps doing that.
 */
export function Table<T>({
  caption,
  captionVisible = false,
  columns,
  rows,
  rowKey,
  sort,
  defaultSort,
  onSortChange,
  onSelectRow,
  selectedKey,
  rowClassName,
  stickyHeader = true,
  maxHeight,
  empty,
  className,
  wrapperClassName,
}: TableProps<T>) {
  const [ownSort, setOwnSort] = useState<SortState | undefined>(defaultSort);
  const active = sort ?? ownSort;

  const setSort = (key: string) => {
    const next: SortState =
      active?.key === key ? { key, dir: active.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
    if (sort === undefined) setOwnSort(next);
    onSortChange?.(next);
  };

  // Only when the active column says how to compare. A sortable column with no
  // `sortValue` is the caller's to order — the header still tracks state.
  const activeColumn = active ? columns.find((c) => c.key === active.key) : undefined;
  const ordered =
    active && activeColumn?.sortValue
      ? [...rows].sort((a, b) => {
          const d = compare(activeColumn.sortValue!(a), activeColumn.sortValue!(b));
          return active.dir === "asc" ? d : -d;
        })
      : rows;

  const selectable = Boolean(onSelectRow);

  // Roving tab stop: one row in the tab order, arrows move within. The selected
  // row owns it, else the first — never all of them, which would make a long
  // table a tab-key trap.
  const tabRow = selectedKey && ordered.some((r) => rowKey(r) === selectedKey) ? selectedKey : ordered[0] ? rowKey(ordered[0]) : undefined;

  const onRowKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, row: T, index: number) => {
    // Inputs, selects and links inside a row own their keyboard interaction.
    if (e.target !== e.currentTarget) return;
    const move = (to: number) => {
      const target = e.currentTarget.parentElement?.children[to];
      if (target instanceof HTMLElement) {
        e.preventDefault();
        target.focus();
      }
    };
    if (e.key === "ArrowDown") move(index + 1);
    else if (e.key === "ArrowUp") move(index - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(ordered.length - 1);
    else if (e.key === "Enter" || e.key === " ") {
      // A control inside the row handles its own keys; only the row itself
      // activates the row.
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      onSelectRow?.(row);
    }
  };

  return (
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className={cx("w-full overflow-x-auto", maxHeight !== undefined && "overflow-y-auto", wrapperClassName)}
      style={maxHeight !== undefined ? { maxHeight: px(maxHeight) } : undefined}
    >
      <table className={cx("w-full border-collapse text-left", className)}>
        <caption
          className={
            captionVisible
              ? "px-4 py-2 text-left text-[12px] tracking-[0.02em] text-ink-mute uppercase"
              : "sr-only"
          }
        >
          {caption}
        </caption>
        <thead className={cx(stickyHeader && "sticky top-0 z-10")}>
          <tr>
            {columns.map((col) => {
              const isActive = active?.key === col.key;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={col.sortable ? (isActive ? ARIA_SORT[active.dir] : "none") : undefined}
                  style={col.width !== undefined ? { width: px(col.width) } : undefined}
                  className={cx(
                    "border-b border-line bg-bg1 px-4 py-3 text-[12px] font-medium text-ink-mute",
                    ALIGN[col.align ?? "left"],
                    col.className
                  )}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => setSort(col.key)}
                      className={cx(
                        "inline-flex min-h-6 items-center gap-1.5 rounded-ctl",
                        "transition-colors duration-[var(--dur-fast)] [transition-timing-function:var(--ease-swift)]",
                        isActive ? "text-ink" : "hover:text-ink"
                      )}
                    >
                      {col.header}
                      {col.headerLabel && <span className="sr-only">{col.headerLabel}</span>}
                      {isActive ? active.dir === "desc"
                        ? <ArrowDown className="h-3.5 w-3.5 text-signal" aria-hidden="true" />
                        : <ArrowUp className="h-3.5 w-3.5 text-signal" aria-hidden="true" />
                        : <ArrowUpDown className="h-3.5 w-3.5 text-ink-faint" aria-hidden="true" />}
                    </button>
                  ) : (
                    <>
                      {col.header}
                      {col.headerLabel && <span className="sr-only">{col.headerLabel}</span>}
                    </>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ordered.length === 0 && empty !== undefined ? (
            <tr>
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          ) : (
            ordered.map((row, index) => {
              const key = rowKey(row);
              const current = selectedKey !== undefined && key === selectedKey;
              return (
                <tr
                  key={key}
                  aria-current={current ? "true" : undefined}
                  tabIndex={selectable ? (key === tabRow ? 0 : -1) : undefined}
                  onClick={selectable ? () => onSelectRow?.(row) : undefined}
                  onKeyDown={selectable ? (e) => onRowKeyDown(e, row, index) : undefined}
                  className={cx(
                    "border-b border-line last:border-b-0",
                    selectable &&
                      "cursor-pointer outline-none transition-colors duration-[var(--dur-fast)] focus-visible:ring-1 focus-visible:ring-signal focus-visible:ring-inset",
                    current ? "bg-signal-dim" : selectable && "hover:bg-bg1",
                    rowClassName?.(row)
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cx(
                        "px-4 py-3 align-top text-[13px] text-ink",
                        ALIGN[col.align ?? "left"],
                        col.className
                      )}
                    >
                      {col.render(row, index)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/** What to put in `empty`: the same padded, explaining block every screen uses. */
function TableEmpty({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("space-y-3 px-4 py-5 text-[13px] text-ink-mute", className)}>{children}</div>;
}

Table.Empty = TableEmpty;
